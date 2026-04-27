import type { Config } from 'tailwindcss'

// Maestro palette per PRODUCT_VISION.md "Brand and Identity":
//   Deep navy base (#0B1929), warm amber accent (#F59E0B), muted greens for
//   success states. Inter for UI, JetBrains Mono for code.

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Deep navy base, surfaces a few shades up.
        navy: {
          950: '#070F1B',
          900: '#0B1929',
          800: '#0F2238',
          700: '#142B47',
          600: '#1B375A',
          500: '#244670',
          400: '#3A6391',
          300: '#5783B3',
          200: '#85A8CD',
          100: '#BCD3E5',
        },
        // Warm amber accent.
        amber: {
          DEFAULT: '#F59E0B',
          50: '#FEF6E1',
          100: '#FCE6B0',
          200: '#FAD27A',
          300: '#F8BE45',
          400: '#F6AD20',
          500: '#F59E0B',
          600: '#C77F08',
          700: '#985F06',
          800: '#6B4204',
          900: '#3F2602',
        },
        // Muted success greens.
        success: {
          400: '#86C8A4',
          500: '#5BAE82',
          600: '#3F8B62',
          700: '#2C6648',
        },
        warning: '#E8A33A',
        danger: '#D8584F',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(245, 158, 11, 0.20), 0 8px 32px -12px rgba(245, 158, 11, 0.30)',
      },
    },
  },
  plugins: [],
} satisfies Config
