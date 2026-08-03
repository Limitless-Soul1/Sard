# Licences for the bundled read-aloud engine

The files in the parent directory are **prebuilt third-party binaries** that Sard ships so that
read-aloud works offline. They are not built from this repository and they are not covered by
Sard's own licence. Their terms are here, in full.

| File | Component | Version | Licence | Text |
| --- | --- | --- | --- | --- |
| `piper.exe` | [Piper](https://github.com/rhasspy/piper) — neural TTS runner | 1.2.0 | MIT | `MIT-piper.txt` |
| `piper_phonemize.dll` | [piper-phonemize](https://github.com/rhasspy/piper-phonemize) — text→phoneme layer | ships with Piper 1.2.0 | MIT | `MIT-piper-phonemize.txt` |
| `espeak-ng.dll`, `espeak-ng-data/` | [eSpeak NG](https://github.com/espeak-ng/espeak-ng) — phonemizer + language data | **1.52.0** | **GPL-3.0-or-later** | `GPL-3.0.txt` |
| `onnxruntime.dll`, `onnxruntime_providers_shared.dll` | [ONNX Runtime](https://github.com/microsoft/onnxruntime) | — | MIT | `MIT-onnxruntime.txt` |
| `libtashkeel_model.ort` | [libtashkeel](https://github.com/mush42/libtashkeel) — Arabic diacritic restoration | — | MIT | `MIT-libtashkeel.txt` |

Versions are read from the binaries themselves: `1.52.0` is the version string embedded in
`espeak-ng.dll`, `1.2.0` the one embedded in `piper.exe`.

`GPL-3.0.txt` is the verbatim GNU General Public License v3 (SHA-256 `8ceb4b9e…65b903`, the
canonical FSF text), supplied because **GPL-3.0 §4 requires a copy of the licence to accompany the
binary** — a link is not sufficient.

## Written offer for the eSpeak NG source (GPL-3.0 §6)

eSpeak NG is conveyed here in object form. The complete corresponding source for this binary is
**eSpeak NG 1.52.0**, available from the upstream project:

> <https://github.com/espeak-ng/espeak-ng/releases/tag/1.52.0>
> <https://github.com/espeak-ng/espeak-ng>

If that upstream location ever becomes unavailable, open an issue on the Sard repository and the
corresponding source will be provided by another means, at no charge beyond the cost of delivery,
for as long as Sard distributes this binary.

Note also that eSpeak NG ships `COPYING.BSD2` (getopt compatibility code) and `COPYING.UCD`
(Unicode Character Database) upstream, covering parts of its own tree. Those terms apply to the
eSpeak NG source, not to anything Sard adds.

## Voice models are not bundled

Piper voice models are **not** included in this directory or in the installer. They are downloaded
on request at runtime and carry their own licences, stated by each voice's upstream publisher.
