/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        dark: {
          DEFAULT: '#0a0a12',
          deep: '#0d0d18',
          sidebar: '#08080f',
        },
        surface: {
          DEFAULT: '#111119',
          hover: '#15152a',
          border: '#1a1a2e',
          dialog: '#131320',
          episode: '#141424',
          'episode-hover': '#1e1e36',
        },
        accent: {
          DEFAULT: '#00d4ff',
          green: '#00f5a0',
        },
        'brand-red': {
          DEFAULT: '#e50914',
          hover: '#ff1a25',
        },
        favorite: '#ffa726',
        rating: '#f39c12',
        success: '#2ecc71',
        'epg-purple': {
          DEFAULT: '#7c4dff',
          light: '#b388ff',
        },
      },
      fontSize: {
        '11': '11px',
        '13': '13px',
        '15': '15px',
        '17': '17px',
        '18': '18px',
        '20': '20px',
        '22': '22px',
        '24': '24px',
        '26': '26px',
        '28': '28px',
        '32': '32px',
        '36': '36px',
        '48': '48px',
        '64': '64px',
      },
      width: {
        'tv': '1920px',
        'sidebar': '68px',
      },
      height: {
        'tv': '1080px',
      },
      animation: {
        'fade-in': 'fadeIn 200ms ease',
        'fade-in-fast': 'fadeIn 120ms ease',
        'scale-in': 'scaleIn 250ms ease',
        'spin-fast': 'spin 0.8s linear infinite',
        'slide-up': 'slideUp 250ms ease',
        'pulse-record': 'pulseRecord 1.5s ease-in-out infinite',
        'double-tap': 'doubleTapRipple 0.6s ease-out forwards',
      },
      keyframes: {
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        scaleIn: {
          from: { opacity: '0', transform: 'scale(0.92)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        slideUp: {
          from: { opacity: '0', transform: 'translateX(-50%) translateY(16px)' },
          to: { opacity: '1', transform: 'translateX(-50%) translateY(0)' },
        },
        pulseRecord: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
        doubleTapRipple: {
          '0%': { background: 'rgba(255, 255, 255, 0.12)' },
          '100%': { background: 'transparent' },
        },
      },
      transitionDuration: {
        '150': '150ms',
        '180': '180ms',
      },
    },
  },
  plugins: [],
}
