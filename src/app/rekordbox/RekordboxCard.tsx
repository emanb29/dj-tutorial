// One optional rekordbox card: numbered steps, what differs, "Done it" and "Not now". No grading.
import type { RekordboxCardChoice } from "@shared/learner.ts";
import type { RekordboxCard as Card } from "./rekordbox-steps.ts";
import "./rekordbox.css";

interface RekordboxCardProps {
  readonly card: Card;
  readonly onChoose: (choice: RekordboxCardChoice["choice"]) => void;
}

export function RekordboxCard({ card, onChoose }: RekordboxCardProps) {
  return (
    <section className="rekordbox-card" aria-label={card.title} data-card={card.id}>
      <h3>{card.title}</h3>
      <ol className="rekordbox-steps">
        {card.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <ul className="rekordbox-differs" aria-label="Differences from the app">
        {card.differs.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <div className="rekordbox-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            onChoose("done");
          }}
        >
          Done it
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            onChoose("notNow");
          }}
        >
          Not now
        </button>
      </div>
    </section>
  );
}
