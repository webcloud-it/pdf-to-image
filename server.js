import express from 'express'
import multer from 'multer'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

const execFileAsync = promisify(execFile)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {fileSize: 25 * 1024 * 1024},
})

const app = express()

// ✅ CORS hard (per evitare che proxy/streaming “perdano” gli header)
app.use((req, res, next) => {
  const origin = req.headers.origin || '*'
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Max-Age', '86400')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

app.get('/health', (req, res) => res.json({ok: true}))

app.get('/', (req, res) => {
  res.status(200).send('OK. Usa POST /pdf-to-image con field multipart "file" (PDF).')
})

app.post('/pdf-to-image', upload.single('file'), async (req, res) => {
  try {
    const f = req.file
    if (!f) return res.status(400).json({error: 'Nessun file'})
    if (f.mimetype !== 'application/pdf') return res.status(415).json({error: 'Solo PDF'})

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-'))
    const pdfPath = path.join(tmpDir, 'input.pdf')
    fs.writeFileSync(pdfPath, f.buffer)

    const outPrefix = path.join(tmpDir, 'page')

    await execFileAsync('pdftoppm', ['-png', '-r', '150', '-f', '1', '-l', '1', pdfPath, outPrefix])

    const outFile = path.join(tmpDir, 'page-1.png')
    if (!fs.existsSync(outFile)) return res.status(500).json({error: 'Conversione fallita'})

    // ✅ qui settiamo esplicitamente gli header (prima dello stream)
    res.status(200)
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Cache-Control', 'no-store')

    fs.createReadStream(outFile).pipe(res)
  } catch (e) {
    res.status(500).json({error: 'Errore conversione'})
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`pdf-to-image listening on ${PORT}`))
