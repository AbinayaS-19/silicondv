// SiliconDV Practice Lab configuration.
//
// Demo mode: API_BASE is "". Accounts and progress live in localStorage,
// nothing leaves the browser, and every page shows the demo strip.
//
// Production mode: set API_BASE to the backend URL with no trailing slash,
// e.g. "https://plab-api.example.com". The app then talks to the real API
// and stores only the session token in localStorage.
window.PLAB_CONFIG = { API_BASE: "" };
