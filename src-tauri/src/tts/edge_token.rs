//! The `Sec-MS-GEC` token the Edge read-aloud service asks of every synthesis connection, version 2.
//!
//! WHAT IT IS. A value anyone can compute, tied to the current five-minute window: it proves nothing about the
//! user, holds no secret, and changes every five minutes. The input is Microsoft's copyright notice, the
//! window's start as a decimal count of 100 ns ticks since 1601-01-01 UTC, and the public client key, in that
//! order. The token is two uppercase hex fields joined by `-`:
//!
//!   * a 64-bit checksum of the input, keyed by the first eight bytes of its SHA-256 digest (16 hex digits,
//!     each 32-bit half little-endian);
//!   * the SHA-256 digest of the input (64 hex digits).
//!
//! WHY VERSION 2. Version 1 was the bare digest of the ticks and the key. From 2026-10-10 the original host
//! refuses it (HTTP 403) and accepts this one; the other host accepts both. Measured 2026-10-24.
//!
//! PROVENANCE. Written for Sard from a description of the algorithm, and checked only against outputs: the
//! example published with the change, and tokens a separate implementation produced as a black box for
//! fixed timestamps (the tests below). No other implementation's code is used or copied.

use sha2::{Digest, Sha256};

/// The public key every Edge read-aloud client sends; part of the token's input and of each request URL.
pub(super) const CLIENT_KEY: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

/// Fixed text the input starts with (57 bytes).
const NOTICE: &[u8] = b"Copyright (C) Microsoft Corporation. All rights reserved.";

/// Seconds from 1601-01-01 to 1970-01-01, the Windows tick epoch's distance from Unix time.
const WINDOWS_EPOCH_SECS: u64 = 11_644_473_600;
const TICKS_PER_SEC: u64 = 10_000_000;
/// Five minutes: the token changes once per window, and the service accepts the current one.
const WINDOW_TICKS: u64 = 300 * TICKS_PER_SEC;

/// The start of the five-minute window containing `unix_secs`, in Windows ticks.
pub(super) fn window_ticks(unix_secs: u64) -> u64 {
    let ticks = (unix_secs + WINDOWS_EPOCH_SECS) * TICKS_PER_SEC;
    ticks - ticks % WINDOW_TICKS
}

/// The token for the window containing `unix_secs`.
pub(super) fn sec_ms_gec(unix_secs: u64) -> String {
    let mut input = Vec::with_capacity(NOTICE.len() + 20 + CLIENT_KEY.len());
    input.extend_from_slice(NOTICE);
    input.extend_from_slice(window_ticks(unix_secs).to_string().as_bytes());
    input.extend_from_slice(CLIENT_KEY.as_bytes());

    let digest = Sha256::digest(&input);
    let (first, second) = checksum64(&input, &digest);

    let mut token = String::with_capacity(16 + 1 + 64);
    for byte in first.to_le_bytes().into_iter().chain(second.to_le_bytes()) {
        token.push_str(&format!("{byte:02X}"));
    }
    token.push('-');
    for byte in digest {
        token.push_str(&format!("{byte:02X}"));
    }
    token
}

/// The keyed 64-bit checksum, as two 32-bit halves. All arithmetic is modulo 2^32.
///
/// The input is read as little-endian 32-bit words (zero-padded to a whole word, then to an even number of
/// words) and consumed two words at a time. Each pair advances two chains: a running state mixed through
/// multiply-and-rotate steps, summed into `acc`, and a second chain over a rotated, differently weighted copy of
/// the same words, summed into `swap_acc`. The halves are the last values of each chain combined with its sum.
fn checksum64(input: &[u8], digest: &[u8]) -> (u32, u32) {
    let key_a = u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]]) | 1;
    let key_b = u32::from_le_bytes([digest[4], digest[5], digest[6], digest[7]]) | 1;
    let rot = |v: u32| v.rotate_left(16);
    let mix = |v: u32, by: u32| rot(v).wrapping_mul(by);

    let mut words: Vec<u32> = input
        .chunks(4)
        .map(|c| {
            let mut w = [0u8; 4];
            w[..c.len()].copy_from_slice(c);
            u32::from_le_bytes(w)
        })
        .collect();
    if words.len() % 2 == 1 {
        words.push(0);
    }

    let (mut state, mut acc, mut swap_last, mut swap_acc) = (0u32, 0u32, 0u32, 0u32);
    for pair in words.chunks_exact(2) {
        let x = pair[0].wrapping_mul(key_a);
        let y = pair[1].wrapping_mul(key_b);

        let q = mix(rot(pair[0]).wrapping_mul(0xEF05_69FB).wrapping_add(x), 0x76F5_0F34);
        swap_acc = swap_acc.wrapping_add(mix(q, 0xC3EF_EA97).wrapping_add(q));
        let q = mix(rot(pair[1]).wrapping_mul(0xC317_13DB).wrapping_add(y), 0x1881_CE3C);
        swap_last = mix(q, 0x35BD_1EC9).wrapping_add(q);
        swap_acc = swap_acc.wrapping_add(swap_last);

        state = state.wrapping_mul(key_a).wrapping_add(x);
        for by in [0xCF98_B111, 0x8708_5B9F, 0x12CE_B96D, 0x257E_1D83] {
            state = mix(state, by);
        }
        acc = acc.wrapping_add(state);

        let t = mix(mix(state.wrapping_mul(key_b).wrapping_add(y), 0xA274_16F5), 0xD383_96FF);
        state = mix(mix(t, 0x7C93_2B89), 0xBFA4_9F69);
        acc = acc.wrapping_add(state);
    }
    (swap_last ^ state, swap_acc ^ acc)
}

#[cfg(test)]
mod tests {
    use super::{sec_ms_gec, window_ticks};

    /// The example published with the version-2 change: the window starting 2026-10-13 10:40:00 UTC.
    #[test]
    fn the_published_example() {
        assert_eq!(
            sec_ms_gec(1_791_888_000),
            "492D7694A183A45E-56E821F95D4579C5B7C7E33DC7303FF379EC36D510213555BBBB9EB17EF15876"
        );
    }

    /// Tokens a separate implementation produced for these timestamps, run as a black box (48 of 48 agreed
    /// when this was written; a spread of them is pinned here). Each covers a different input, so every step of
    /// the checksum and the digest is exercised.
    #[test]
    fn tokens_agree_with_an_independent_implementation() {
        let vectors = [
            (1_609_459_200, "0548AAA9D28D83D6-BAAD4C2ADC7C1D94CBB1809DFE512562E2430B3B3C8F49C25D48F790646565AA"),
            (1_700_000_123, "0919602B5750900A-EC9DD394F23CB5635CF62A0E8E24136DCD32B26D10C543B10082E482D7516397"),
            (1_800_000_000, "99E54519B490BE5C-E162DB0977FBDCB9B86DD8148BF1BCDC3C0303176CE39852A42B415935C20654"),
            (2_000_000_000, "2D62557F1142BC5D-FD9C30C68FF194A5EE6B45FEFC5E2BA1D1239F88A90569AB55CFFFAA7799F40E"),
            (4_102_444_799, "B84BB9723EDE320A-AC5CED4D94BFDD28B4DDDBA21B9CF57EEB44044CD14B7D1A1F1CEB4CB04E43F4"),
        ];
        for (unix, expected) in vectors {
            assert_eq!(sec_ms_gec(unix), expected, "unix {unix}");
        }
    }

    #[test]
    fn one_token_per_five_minute_window() {
        assert_eq!(window_ticks(1_791_888_000), 134_363_616_000_000_000);
        assert_eq!(window_ticks(1_791_888_299), 134_363_616_000_000_000, "the last second of the window");
        assert_eq!(window_ticks(1_791_888_300), 134_363_619_000_000_000, "the next window");
        assert_eq!(sec_ms_gec(1_791_888_299), sec_ms_gec(1_791_888_000));
        assert_eq!(
            sec_ms_gec(1_791_888_300),
            "6D26B5F5B70269AD-280E82E1BBE24E4E8866E3502EB6277B9436F61ABDC1C224518A038BBD7BBDAD"
        );
    }

    #[test]
    fn the_token_has_the_shape_the_service_expects() {
        let t = sec_ms_gec(1_791_888_000);
        let (checksum, digest) = t.split_once('-').unwrap();
        assert_eq!((checksum.len(), digest.len()), (16, 64));
        assert!(t.chars().all(|c| c == '-' || c.is_ascii_digit() || c.is_ascii_uppercase()), "{t}");
    }
}
