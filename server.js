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

app.get('/health', (req, res) => {
  res.json({ok: true})
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

    // Converte solo la prima pagina, PNG a 150 DPI
    await execFileAsync('pdftoppm', ['-png', '-r', '150', '-f', '1', '-l', '1', pdfPath, outPrefix])

    const outFile = path.join(tmpDir, 'page-1.png')
    if (!fs.existsSync(outFile)) {
      return res.status(500).json({error: 'Conversione fallita'})
    }

    res.setHeader('Content-Type', 'image/png')
    fs.createReadStream(outFile).pipe(res)
  } catch (e) {
    res.status(500).json({error: 'Errore conversione'})
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`pdf-to-image listening on ${PORT}`)
})
