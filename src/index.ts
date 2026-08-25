import 'dotenv/config'
import { serve } from '@hono/node-server'
import { env } from './config/env.js'
import { app } from './app.js'

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`🚀 aroge-api listening on http://localhost:${info.port}`)
})