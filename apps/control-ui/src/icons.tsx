import type { SVGProps } from "react";

export type IconName =
  | "overview"
  | "channels"
  | "spaces"
  | "threads"
  | "router"
  | "settings"
  | "diagnostics";

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  const shared = {
    width: 20,
    height: 20,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true
  };
  const paths = {
    overview: <><path d="m3.5 10.8 8.5-7 8.5 7" /><path d="M5.5 9.7v10h13v-10M9.5 19.7v-6h5v6" /></>,
    channels: <><circle cx="6" cy="6" r="2.3" /><circle cx="18" cy="6" r="2.3" /><circle cx="12" cy="18" r="2.3" /><path d="m7.8 7.5 2.8 7.8m5.6-7.8-2.8 7.8M8.3 6h7.4" /></>,
    spaces: <><path d="M4 5.5h16v10H8l-4 3.5z" /><path d="M8 9h8m-8 3h5" /></>,
    threads: <><path d="M8 3 6 21m11-18-2 18M3 9h18M2 15h18" /></>,
    router: <><circle cx="6" cy="5" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="10" cy="19" r="2" /><path d="M7.7 6.1 9.4 8c1.2 1.4 1.6 3.2 1.2 5l-.8 4m2.2-7 4.2-2.8" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>,
    diagnostics: <><path d="M3 12h4l2-6 4 12 2-6h6" /><path d="M3 20h18" /></>
  } satisfies Record<IconName, React.ReactNode>;

  return <svg {...shared} {...props}>{paths[name]}</svg>;
}
