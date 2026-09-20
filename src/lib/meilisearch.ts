import { Meilisearch } from 'meilisearch'
import { env } from '../config/env.js'

export const meilisearch = new Meilisearch({
  host: env.MEILISEARCH_URL,
  apiKey: env.MEILISEARCH_API_KEY,
})

export const LISTINGS_INDEX = 'listings'

export const listingsIndex = meilisearch.index(LISTINGS_INDEX)
