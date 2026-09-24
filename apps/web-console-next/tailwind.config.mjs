/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "fade-out": {
          from: { opacity: "1" },
          to: { opacity: "0" },
        },
        // Dialog enter/exit. The centering `translate(-50%, -50%)` is baked in
        // so the scale animation never clobbers it — otherwise the dialog
        // animates from an off-center position and snaps to center.
        "dialog-in": {
          from: { opacity: "0", transform: "translate(-50%, -50%) scale(0.96)" },
          to: { opacity: "1", transform: "translate(-50%, -50%) scale(1)" },
        },
        "dialog-out": {
          from: { opacity: "1", transform: "translate(-50%, -50%) scale(1)" },
          to: { opacity: "0", transform: "translate(-50%, -50%) scale(0.96)" },
        },
        "slide-in-left": {
          from: { transform: "translateX(-100%)" },
          to: { transform: "translateX(0)" },
        },
        "slide-out-left": {
          from: { transform: "translateX(0)" },
          to: { transform: "translateX(-100%)" },
        },
        "slide-in-right": {
          from: { transform: "translateX(100%)" },
          to: { transform: "translateX(0)" },
        },
        "slide-out-right": {
          from: { transform: "translateX(0)" },
          to: { transform: "translateX(100%)" },
        },
        "slide-in-bottom": {
          from: { transform: "translateY(100%)" },
          to: { transform: "translateY(0)" },
        },
        "slide-out-bottom": {
          from: { transform: "translateY(0)" },
          to: { transform: "translateY(100%)" },
        },
        "pop-in": {
          from: { opacity: "0", transform: "translateY(4px) scale(0.98)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        "pop-out": {
          from: { opacity: "1", transform: "translateY(0) scale(1)" },
          to: { opacity: "0", transform: "translateY(4px) scale(0.98)" },
        },
        // Subtle directional swap for the sidebar nav (product <-> settings).
        "sidebar-in-right": {
          from: { opacity: "0", transform: "translateX(10px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        "sidebar-in-left": {
          from: { opacity: "0", transform: "translateX(-10px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
      },
      animation: {
        // iOS-style easing for sheets so the panel decelerates naturally.
        "fade-in": "fade-in 150ms ease-out",
        "fade-out": "fade-out 150ms ease-in",
        "dialog-in": "dialog-in 180ms cubic-bezier(0.32, 0.72, 0, 1)",
        "dialog-out": "dialog-out 140ms ease-in",
        "slide-in-left": "slide-in-left 280ms cubic-bezier(0.32, 0.72, 0, 1)",
        "slide-out-left": "slide-out-left 220ms cubic-bezier(0.32, 0.72, 0, 1)",
        "slide-in-right": "slide-in-right 280ms cubic-bezier(0.32, 0.72, 0, 1)",
        "slide-out-right": "slide-out-right 220ms cubic-bezier(0.32, 0.72, 0, 1)",
        "slide-in-bottom": "slide-in-bottom 300ms cubic-bezier(0.32, 0.72, 0, 1)",
        "slide-out-bottom": "slide-out-bottom 220ms cubic-bezier(0.32, 0.72, 0, 1)",
        "pop-in": "pop-in 140ms ease-out",
        "pop-out": "pop-out 110ms ease-in",
        "sidebar-in-right": "sidebar-in-right 220ms cubic-bezier(0.32, 0.72, 0, 1)",
        "sidebar-in-left": "sidebar-in-left 220ms cubic-bezier(0.32, 0.72, 0, 1)",
        shimmer: "shimmer 1.6s linear infinite",
      },
    },
  },
  plugins: [],
};
