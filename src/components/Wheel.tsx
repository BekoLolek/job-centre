"use client";

import { useEffect, useRef, useState } from "react";
import type { Spin } from "@/lib/types";

const SIZE = 420;
const CX = SIZE / 2;
const CY = SIZE / 2;
const R = SIZE / 2 - 14;

const TRACK_A = "#15181c";
const TRACK_B = "#1d2228";

function point(angleDeg: number, radius: number) {
  const a = (angleDeg * Math.PI) / 180;
  return { x: CX + radius * Math.sin(a), y: CY - radius * Math.cos(a) };
}

function wedge(startDeg: number, endDeg: number, radius: number) {
  const s = point(startDeg, radius);
  const e = point(endDeg, radius);
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${CX} ${CY} L ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${radius} ${radius} 0 ${largeArc} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)} Z`;
}

function easeOutQuart(t: number) {
  return 1 - Math.pow(1 - t, 4);
}

export default function Wheel({
  pool,
  spin,
  clockOffset,
  onSettled,
}: {
  pool: string[];
  spin: Spin | null;
  /** serverNow - clientNow, so every browser animates on the same clock. */
  clockOffset: number;
  onSettled?: (player: string) => void;
}) {
  const names = spin ? spin.pool : pool;
  const count = names.length;
  const [rotation, setRotation] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const settledFor = useRef<number | null>(null);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (!spin || spin.pool.length === 0) {
      setRotation(0);
      setSpinning(false);
      return;
    }

    const seg = 360 / spin.pool.length;
    const target = (spin.targetIndex + 0.5) * seg;
    const total = spin.turns * 360 - target;

    const tick = () => {
      const now = Date.now() + clockOffset;
      const t = Math.min(1, Math.max(0, (now - spin.startedAt) / spin.durationMs));
      setRotation(easeOutQuart(t) * total);
      if (t < 1) {
        setSpinning(true);
        frame.current = requestAnimationFrame(tick);
      } else {
        setSpinning(false);
        if (settledFor.current !== spin.startedAt) {
          settledFor.current = spin.startedAt;
          onSettled?.(spin.pool[spin.targetIndex]);
        }
      }
    };

    tick();
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
    // onSettled is intentionally excluded — it is called once per spin.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spin?.startedAt, spin?.targetIndex, spin?.durationMs, spin?.turns, clockOffset]);

  const settled = !!spin && !spinning;
  const showLabels = count > 0 && count <= 40;
  const labelSize = count <= 10 ? 14 : count <= 18 ? 12 : count <= 30 ? 10 : 9;

  return (
    <div className="relative w-full max-w-[420px] aspect-square select-none">
      {/* Pointer */}
      <div className="absolute left-1/2 -translate-x-1/2 -top-1 z-20">
        <svg width="30" height="34" viewBox="0 0 30 34" aria-hidden>
          <path d="M15 32 L2 2 L28 2 Z" fill="var(--ember)" />
          <path d="M15 26 L7 6 L23 6 Z" fill="#0a0b0c" opacity="0.35" />
        </svg>
      </div>

      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="absolute inset-0 h-full w-full drop-shadow-[0_25px_60px_rgba(0,0,0,0.6)]"
      >
        <defs>
          <radialGradient id="hub" cx="50%" cy="35%">
            <stop offset="0%" stopColor="#22272d" />
            <stop offset="100%" stopColor="#0c0e10" />
          </radialGradient>
        </defs>

        <circle cx={CX} cy={CY} r={R + 10} fill="#0c0e10" stroke="var(--hair)" strokeWidth="1" />

        <g
          style={{
            transform: `rotate(${rotation}deg)`,
            transformOrigin: `${CX}px ${CY}px`,
            willChange: "transform",
          }}
        >
          {count === 0 && <circle cx={CX} cy={CY} r={R} fill={TRACK_A} />}

          {count === 1 && (
            <circle cx={CX} cy={CY} r={R} fill={settled ? "var(--gold)" : TRACK_B} />
          )}

          {count > 1 &&
            names.map((name, i) => {
              const seg = 360 / count;
              const isTarget = settled && spin?.targetIndex === i;
              return (
                <path
                  key={`${name}-${i}`}
                  d={wedge(i * seg, (i + 1) * seg, R)}
                  fill={isTarget ? "var(--gold)" : i % 2 === 0 ? TRACK_A : TRACK_B}
                  stroke="rgba(255,255,255,0.06)"
                  strokeWidth="1"
                />
              );
            })}

          {showLabels &&
            names.map((name, i) => {
              const seg = 360 / count;
              const mid = (i + 0.5) * seg;
              // Names run along the spoke instead of across it, so 24 thin wedges still
              // fit. Segments past the 6 o'clock mark flip so nothing reads upside down.
              const flip = mid > 180;
              const pos = point(mid, R * 0.95);
              const isTarget = settled && spin?.targetIndex === i;
              return (
                <text
                  key={`label-${name}-${i}`}
                  x={pos.x}
                  y={pos.y}
                  fill={isTarget ? "#17140b" : "#cfd4da"}
                  fontSize={labelSize}
                  fontFamily="var(--font-mono), monospace"
                  textAnchor={flip ? "start" : "end"}
                  dominantBaseline="middle"
                  transform={`rotate(${flip ? mid + 90 : mid - 90} ${pos.x} ${pos.y})`}
                  style={{ pointerEvents: "none" }}
                >
                  {name.length > 20 ? `${name.slice(0, 19)}…` : name}
                </text>
              );
            })}
        </g>

        <circle cx={CX} cy={CY} r={54} fill="url(#hub)" stroke="var(--hair)" />
        <circle cx={CX} cy={CY} r={54} fill="none" stroke="rgba(227,178,60,0.25)" strokeWidth="1" />
        <text
          x={CX}
          y={CY - 6}
          textAnchor="middle"
          fill="var(--gold)"
          fontFamily="var(--font-display), sans-serif"
          fontSize="26"
        >
          {count}
        </text>
        <text
          x={CX}
          y={CY + 14}
          textAnchor="middle"
          fill="var(--muted)"
          fontFamily="var(--font-mono), monospace"
          fontSize="8"
          letterSpacing="2"
        >
          LEFT
        </text>
      </svg>
    </div>
  );
}
