import type { NextApiRequest, NextApiResponse } from 'next'
import { authorized } from '@app/fns/probe-auth'
import { runProbe } from '@app/fns/probe-server'

export const config = {
  maxDuration: 300,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    res.status(405).json({ error: 'method not allowed' })
    return
  }
  if (!authorized(req.headers.authorization)) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }

  const snapshot = await runProbe(24)
  res.setHeader('Cache-Control', 'no-store')
  res.status(200).json(snapshot)
}
