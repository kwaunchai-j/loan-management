import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // No web font is downloaded: the phone's own Thai font is used (Noto Sans Thai on Android, Thonburi on iPhone).
      fontFamily: {
        sans: ['"Noto Sans Thai"', "Sarabun", "Thonburi", "Tahoma", "system-ui", "sans-serif"],
      },
      boxShadow: {
        // a soft two-layer shadow: a tight contact shadow plus a wide, faint lift
        card: "0 1px 2px rgb(15 23 42 / 0.05), 0 8px 24px -12px rgb(15 23 42 / 0.12)",
        lift: "0 2px 4px rgb(15 23 42 / 0.06), 0 14px 30px -14px rgb(13 148 136 / 0.35)",
      },
      keyframes: {
        rise: { from: { opacity: "0", transform: "translateY(6px)" }, to: { opacity: "1", transform: "translateY(0)" } },
      },
      animation: { rise: "rise 0.25s ease-out both" },
    },
  },
  plugins: [],
};

export default config;
