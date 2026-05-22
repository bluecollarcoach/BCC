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
        // Internal-app palette: dark chrome + warm amber accent + light content
        ink: {
          DEFAULT: "#1a1a1a",
          50: "#f5f5f5",
          100: "#e5e5e5",
          200: "#c7c7c7",
          300: "#9e9e9e",
          400: "#6e6e6e",
          500: "#3d3d3d",
          600: "#2b2b2b",
          700: "#222222",
          800: "#1a1a1a",
          900: "#0f0f0f",
        },
        steel: {
          DEFAULT: "#475569",
          400: "#64748b",
          500: "#475569",
          600: "#374151",
          700: "#1e293b",
        },
        amber: {
          DEFAULT: "#c8901c",
          50: "#fdf6e3",
          100: "#faecc5",
          200: "#f4d57a",
          300: "#e8b94a",
          400: "#d6a02e",
          500: "#c8901c",
          600: "#a87614",
          700: "#7d5810",
          800: "#523a0a",
          900: "#291d05",
        },
        cream: "#faf6ed",
        // Semantic tokens (CSS vars in globals.css)
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
        chrome: {
          DEFAULT: "hsl(var(--chrome) / <alpha-value>)",
          foreground: "hsl(var(--chrome-foreground) / <alpha-value>)",
          muted: "hsl(var(--chrome-muted) / <alpha-value>)",
          border: "hsl(var(--chrome-border) / <alpha-value>)",
        },
        border: "hsl(var(--border) / <alpha-value>)",
        ring: "hsl(var(--ring) / <alpha-value>)",
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
        },
        success: "hsl(var(--success) / <alpha-value>)",
        warning: "hsl(var(--warning) / <alpha-value>)",
        // Compat alias for any leftover `gold` references in components
        gold: {
          DEFAULT: "#c8901c",
          500: "#c8901c",
          600: "#a87614",
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "Inter", "system-ui", "sans-serif"],
        display: ["var(--font-inter)", "Inter", "system-ui", "sans-serif"],
      },
      borderRadius: {
        lg: "14px",
        md: "10px",
        sm: "6px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(15, 23, 42, 0.06), 0 4px 12px rgba(15, 23, 42, 0.04)",
        "card-lifted":
          "0 12px 40px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(255, 255, 255, 0.04)",
        amber:
          "0 0 0 1px rgba(200, 144, 28, 0.35), 0 8px 30px -10px rgba(200, 144, 28, 0.25)",
        // Compat alias used by some pages copied from the BCC project
        glow:
          "0 0 0 1px rgba(200, 144, 28, 0.35), 0 8px 30px -10px rgba(200, 144, 28, 0.25)",
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
      letterSpacing: {
        tightest: "-0.04em",
      },
    },
  },
  plugins: [],
};

export default config;
