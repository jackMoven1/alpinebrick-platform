import '@testing-library/jest-dom/vitest'

// jsdom does not implement window.scrollTo. Root's ScrollToTop calls it on
// every navigation, which floods stderr with "Not implemented" traces and can
// bury a genuine error. Stub it rather than let the noise accumulate.
window.scrollTo = () => {}
