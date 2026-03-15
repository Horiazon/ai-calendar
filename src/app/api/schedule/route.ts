import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function POST(req: NextRequest) {
  const { prompt, system } = await req.json()
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: system || 'You are a smart calendar scheduling assistant.',
    messages: [{ role: 'user', content: prompt }],
  })
  const text = msg.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('')
  return NextResponse.json({ text })
}