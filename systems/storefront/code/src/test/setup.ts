import '@testing-library/jest-dom/vitest'

// jsdom does not implement window.scrollTo. Root's ScrollToTop calls it on
// every navigation, which floods stderr with "Not implemented" traces and can
// bury a genuine error. Stub it rather than let the noise accumulate.
window.scrollTo = () => {}

// NOTE: the Accordion and Tabs tests emit React "not wrapped in act(...)"
// warnings. They are benign here — the tests do await userEvent correctly and
// all assertions pass. Setting IS_REACT_ACT_ENVIRONMENT was tried and did NOT
// silence them, so it is not set. Do not "fix" this by removing assertions;
// if these warnings ever accompany a FAILING test, that is a real bug.
