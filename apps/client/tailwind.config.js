/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: "#ff5500", // Neon Orange
        brandHover: "#ff7733",
        surface: "#0a0a0a", // Darkest Charcoal
        background: "#000000", // Pure Black
        neonGreen: "#39ff14",
        neonBlue: "#00f3ff",
        neonPink: "#ff00ff",
      },
      boxShadow: {
        "neon-brand": "0 0 8px rgba(255, 85, 0, 0.5)",
        "neon-green": "0 0 8px rgba(57, 255, 20, 0.5)",
        "neon-blue": "0 0 8px rgba(0, 243, 255, 0.5)",
        "neon-pink": "0 0 8px rgba(255, 0, 255, 0.5)",
      },
      dropShadow: {
        "glow-brand": "0 0 6px rgba(255, 85, 0, 0.5)",
        "glow-green": "0 0 6px rgba(57, 255, 20, 0.5)",
        "glow-blue": "0 0 6px rgba(0, 243, 255, 0.5)",
      },
    },
  },
  plugins: [],
};
