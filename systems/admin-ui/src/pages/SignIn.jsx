export default function SignIn() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-sm rounded-card bg-white p-8 text-center shadow-card">
        <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-card bg-brand font-bold text-white">
          IB
        </div>
        <h1 className="mt-4 text-xl font-bold text-ink">Alpine Brick Admin</h1>
        <p className="mt-2 text-sm text-gray-500">Access is limited to approved accounts.</p>
        <a
          href="/api/v1/auth/google/start"
          className="mt-6 inline-flex w-full items-center justify-center rounded-pill bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark"
        >
          Sign in with Google
        </a>
      </div>
    </div>
  )
}
