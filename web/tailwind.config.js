/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      colors: {
        ink: {
          DEFAULT: '#0f172a',
          soft: '#334155',
          mute: '#64748b',
        },
        ant: {
          DEFAULT: '#fb923c',
          deep: '#ea580c',
        },
      },
    },
  },
  plugins: [],
};
