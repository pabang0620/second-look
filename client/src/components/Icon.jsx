// Small line icons. Each one sits next to words that say the same thing, so it is hidden from screen readers.
const PATHS = {
  check: <path d="M4 12.5l5 5L20 6.5" />,
  stop: <><path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z" /><path d="M9 9l6 6M15 9l-6 6" /></>,
  lock: <><rect x="4.5" y="10.5" width="15" height="10.5" rx="2" /><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" /></>,
  alert: <><path d="M12 3.5l9.5 16.5h-19z" /><path d="M12 10v4.5" /><path d="M12 17.3v.2" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.2 2" /></>,
  phone: <path d="M5 3h3.5l2 5-2.5 1.6a11 11 0 0 0 6.4 6.4L16 13.5l5 2V19a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2z" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5" /><path d="M12 7.5v.2" /></>,
  question: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1.9-1.1 1.6v.4" /><path d="M12 17.2v.3" /></>,
}

export default function Icon({ name }) {
  return (
    <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  )
}
