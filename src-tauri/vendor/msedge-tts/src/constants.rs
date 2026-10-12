pub const VOICE_LIST_URL: &str = "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4";
// Updated USER_AGENT to reflect the latest changes as of January 11, 2026.
pub const USER_AGENT: &str = "Mozilla/5.0 (Linux; Android 10; HD1913) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.7499.193 Mobile Safari/537.36 EdgA/143.0.3650.125";
// SARD LOCAL MODIFICATION — one of the two changes to this vendored crate; see ../../VENDOR.txt.
// The synthesis WebSocket host Microsoft Edge itself connects to. Same client key, now passed as
// `Ocp-Apim-Subscription-Key`; the ConnectionId, Sec-MS-GEC and Sec-MS-GEC-Version parameters that
// `build_websocket_request` appends are unchanged. The voice list above stays on its original host.
pub const WSS_URL: &str = "wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1?Ocp-Apim-Subscription-Key=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=";
pub const ORIGIN: &str = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
