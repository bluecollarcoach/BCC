import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx,mdx}"],
  darkMode: "class",
  theme: {
    container: {
      center: true,
      padding: { DEFAULT: "1rem", sm: "1.5rem", lg: "2rem" },
      screens: { "2xl": "1440px" },
    },
    extend: {
      colors: {
        // Blue Collar Coach brand palette (lifted from bluecollarcoach.us)
        ink: {
          DEFAULT: "#1a1a1a",
          50: "#f5f5f5",
          100: "#e5e5e5",
          200: "#c7c7c7",
          300: "#9e9e9e",
          400: "#6e6e6e",
          500: "#4a4a4a",
          600: "#2e2e2e",
          700: "#222222",
          800: "#1a1a1a",
          900: "#0f0f0f",
          950: "#080808",
        },
        gold: {
          DEFAULT: "#c5a55a",
          50: "#fbf6e9",
          100: "#f5ebca",
          200: "#ead693",
          300: "#dec25c",
          400: "#d2b045",
          500: "#c5a55a",
          600: "#b8944f",
          700: "#8e7138",
          800: "#665224",
          900: "#3d3115",
        },
        // Semantic tokens (referenced via CSS vars in globals.css)
        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        muted: {
          DEFAULT: "hsl(var(--muted) / <alpha-value>)",
          foreground: "hsl(var(--muted-foreground) / <alpha-value>)",
        },
        card: {
          DEFAULT: "hsl(var(--card) / <alpha-value>)",
          foreground: "hsl(var(--card-foreground) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "hsl(var(--accent) / <alpha-value>)",
          foreground: "hsl(var(--accent-foreground) / <alpha-value>)",
        },
        border: "hsl(var(--border) / <alpha-value>)",
        ring: "hsl(var(--ring) / <alpha-value>)",
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
        },
        success: "hsl(var(--success) / <alpha-value>)",
        warning: "hsl(var(--warning) / <alpha-value>)",
      },
      fontFamily: {
        serif: ["Georgia", "Times New Roman", "serif"],
        sans: ["Inter", "DM Sans", "system-ui", "sans-serif"],
        display: ["Libre Baskerville", "Georgia", "serif"],
      },
      borderRadius: {
        lg: "10px",
        md: "6px",
        sm: "3px",
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(197,165,90,0.35), 0 8px 30px -10px rgba(197,165,90,0.25)",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        pulse_dot: {
          "0%,100%": { opacity: "1" },
          "50%": { opacity: "0.4" },
        },
      },
      animation: {
        "fade-in": "fade-in 200ms ease-out",
        "pulse-dot": "pulse_dot 1.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
