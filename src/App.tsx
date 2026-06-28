import "./styles/global.css";
import { Reader } from "./features/reader/Reader";

// RAWY-09: the app now opens & renders an EPUB through the reader-engine layer.
// Still a foundation — no themes / typography UI / library yet.
function App() {
  return <Reader />;
}

export default App;
