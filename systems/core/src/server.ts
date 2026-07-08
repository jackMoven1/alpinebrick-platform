import { buildApp } from './app.js'

const port = Number(process.env.PORT ?? 4000)
buildApp().listen(port, () => console.log(`core listening on :${port}`))
