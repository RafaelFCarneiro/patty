/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: '#111827',
        surface: '#1f2937',
        'surface-2': '#374151',
        primary: '#7c3aed',
        'primary-hover': '#6d28d9',
        accent: '#06b6d4',
        income: '#22c55e',
        expense: '#ef4444',
        muted: '#6b7280',
        border: '#374151',
      },
    },
  },
  plugins: [],
};
