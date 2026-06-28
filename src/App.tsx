import "./styles/global.css";

// RAWY-05 skeleton: an empty, tasteful shell. No reading/library/DB yet — those
// land in later tasks (see PROJECT.md §6). This just confirms the app launches.
function App() {
  return (
    <main className="erawy-shell" dir="rtl">
      <div>
        <h1 className="erawy-wordmark">الرَّاوِي</h1>
        <p className="erawy-tagline">
          eRawy — <span className="erawy-accent">the storyteller</span> · skeleton shell
        </p>
      </div>
    </main>
  );
}

export default App;
