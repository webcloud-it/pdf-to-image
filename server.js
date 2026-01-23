import express from 'express'
import multer from 'multer'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {promisify} from 'node:util'
import {execFile} from 'node:child_process'
import crypto from 'node:crypto'

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
  res.status(200).send('OK. Usa POST /pdf-to-images con field multipart "file" (PDF).')
})

function listPages(tmpDir) {
  // pdftoppm produce: page-1.png, page-2.png, ...
  const files = fs
    .readdirSync(tmpDir)
    .filter(f => /^page-\d+\.png$/i.test(f))
    .sort((a, b) => {
      const na = Number(a.match(/\d+/)?.[0] || 0)
      const nb = Number(b.match(/\d+/)?.[0] || 0)
      return na - nb
    })

  return files.map(f => ({
    filename: f,
    page: Number(f.match(/\d+/)?.[0] || 0),
    fullpath: path.join(tmpDir, f),
  }))
}

app.post('/pdf-to-image', upload.single('file'), async (req, res) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-'))
  const boundary = 'pdf2img-' + crypto.randomBytes(12).toString('hex')

  try {
    const f = req.file
    if (!f) return res.status(400).json({error: 'Nessun file'})

    res.status(200)
    res.setHeader('Content-Type', `multipart/mixed; boundary=${boundary}`)
    res.setHeader('Cache-Control', 'no-store')

    const isPdf =
      f.mimetype === 'application/pdf' || (f.originalname || '').toLowerCase().endsWith('.pdf')

    // ✅ Se NON è PDF: restituisco comunque 1 parte (come "multi-file" coerente)
    if (!isPdf) {
      // se arriva un'immagine, la trattiamo come "pagina 1"
      const filename = (f.originalname || 'image').replace(/[^\w.\-]+/g, '_')
      res.write(`--${boundary}\r\n`)
      res.write(`Content-Type: ${f.mimetype || 'application/octet-stream'}\r\n`)
      res.write(`Content-Disposition: attachment; filename="${filename}"\r\n`)
      res.write(`X-Page-Number: 1\r\n`)
      res.write(`Content-Length: ${f.buffer.length}\r\n`)
      res.write(`\r\n`)
      res.write(f.buffer)
      res.write(`\r\n`)
      return res.end(`--${boundary}--\r\n`)
    }

    // ✅ PDF → converto tutte le pagine e ritorno N parti PNG
    const dpi = Math.max(72, Math.min(600, Number(req.query.dpi || 200)))

    const pdfPath = path.join(tmpDir, 'input.pdf')
    fs.writeFileSync(pdfPath, f.buffer)

    const outPrefix = path.join(tmpDir, 'page')
    await execFileAsync('pdftoppm', ['-png', '-r', String(dpi), pdfPath, outPrefix])

    const pages = listPages(tmpDir)
    if (!pages.length) {
      res.write(`--${boundary}\r\n`)
      res.write(`Content-Type: application/json\r\n\r\n`)
      res.write(JSON.stringify({error: 'Conversione fallita (nessuna pagina prodotta)'}))
      res.write(`\r\n`)
      return res.end(`--${boundary}--\r\n`)
    }

    for (const p of pages) {
      const buf = fs.readFileSync(p.fullpath)
      res.write(`--${boundary}\r\n`)
      res.write(`Content-Type: image/png\r\n`)
      res.write(`Content-Disposition: attachment; filename="${p.filename}"\r\n`)
      res.write(`X-Page-Number: ${p.page}\r\n`)
      res.write(`Content-Length: ${buf.length}\r\n`)
      res.write(`\r\n`)
      res.write(buf)
      res.write(`\r\n`)
    }

    res.end(`--${boundary}--\r\n`)
  } catch (e) {
    // ⚠️ non posso più fare res.status(500) dopo che ho iniziato a streammare
    try {
      res.write(`--${boundary}\r\n`)
      res.write(`Content-Type: application/json\r\n\r\n`)
      res.write(JSON.stringify({error: 'Errore conversione'}))
      res.write(`\r\n`)
      res.end(`--${boundary}--\r\n`)
    } catch {}
  } finally {
    try {
      fs.rmSync(tmpDir, {recursive: true, force: true})
    } catch {}
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`pdf-to-image listening on ${PORT}`))
