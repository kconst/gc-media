import type { TrackMetric } from "./TrackOverlay";

const MPS_TO_MPH = 2.23694;

interface Props {
  metric: TrackMetric;
  onChange: (m: TrackMetric) => void;
  hasHr: boolean;
  domain: [number, number] | null;
}

function formatBound(metric: TrackMetric, v: number): string {
  return metric === "hr" ? `${Math.round(v)} bpm` : `${Math.round(v * MPS_TO_MPH)} mph`;
}

export function TrackControls({ metric, onChange, hasHr, domain }: Props) {
  return (
    <div className="track-ctl">
      <div className="track-switch" role="group" aria-label="Path color metric">
        <button
          className={metric === "speed" ? "on" : ""}
          onClick={() => onChange("speed")}
        >
          Speed
        </button>
        <button
          className={metric === "hr" ? "on" : ""}
          disabled={!hasHr}
          title={hasHr ? "" : "No heart-rate data in this track"}
          onClick={() => onChange("hr")}
        >
          Heart rate
        </button>
      </div>
      {domain && (
        <div className="track-legend">
          <span>{formatBound(metric, domain[0])}</span>
          <span className="ramp" />
          <span>{formatBound(metric, domain[1])}</span>
        </div>
      )}
    </div>
  );
}
