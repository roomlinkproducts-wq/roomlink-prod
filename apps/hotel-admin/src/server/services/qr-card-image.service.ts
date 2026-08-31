import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import sharp from 'sharp'
import QRCode from 'qrcode'
import { QR_CARD_TEMPLATE_BASE64 } from '@/assets/qr-card-template.base64'
import { PT_SERIF_BOLD_BASE64, PT_SANS_BOLD_BASE64 } from '@/assets/qr-card-fonts.base64'

// Embedded directly as a base64 module constant rather than read from a
// separate file at request time: on Vercel, neither process.cwd() (public/
// is deployed to the static/CDN layer, not the function's own filesystem)
// nor __dirname (webpack relocates this module into a shared server chunk,
// so __dirname no longer points at the source tree) reliably resolve to the
// asset at runtime — both were tried and both 404/ENOENT'd in a production
// build. Baking the bytes into the compiled module sidesteps path
// resolution entirely.
const TEMPLATE_BUFFER = Buffer.from(QR_CARD_TEMPLATE_BASE64, 'base64')
const TEMPLATE_WIDTH = 1024
const TEMPLATE_HEIGHT = 1536
// 1024x1536px is a 4x6in card only at this density. sharp defaults PNG
// output to 72 DPI density metadata (unrelated to pixel dimensions), so
// without setting this explicitly the file's pixels are right but printing
// it "at actual size" (Preview, Photoshop, most photo-printing software)
// yields ~14.2x21.3in instead of 4x6in.
const TEMPLATE_DPI = 256

/**
 * Vercel's Node.js runtime (AWS Lambda under the hood) ships zero fonts —
 * sharp's SVG renderer (librsvg, via Pango/fontconfig) silently omits any
 * <text> it can't match a font for, with no error, so the hotel name/room
 * number rendered locally (where the OS has Georgia/Arial) but vanished in
 * production. Fix: bundle actual font files, write them to /tmp (the one
 * writable directory in a Lambda), and point fontconfig at that directory
 * explicitly via FONTCONFIG_FILE. Confirmed this works even set *after*
 * sharp is already require()'d — fontconfig initializes lazily on first
 * actual text render, not at module load.
 *
 * Memoized module-level promise: /tmp persists across warm invocations of
 * the same Lambda instance, so this only needs to run once per cold start,
 * not once per request.
 */
let fontsReadyPromise: Promise<void> | null = null

function ensureFontsConfigured(): Promise<void> {
  if (!fontsReadyPromise) {
    fontsReadyPromise = (async () => {
      const fontDir = path.join(os.tmpdir(), 'roomlink-qr-card-fonts')
      await fs.mkdir(fontDir, { recursive: true })

      const serifPath = path.join(fontDir, 'PTSerif-Bold.ttf')
      const sansPath = path.join(fontDir, 'PTSans-Bold.ttf')
      const confPath = path.join(fontDir, 'fonts.conf')

      await Promise.all([
        fs.writeFile(serifPath, Buffer.from(PT_SERIF_BOLD_BASE64, 'base64')),
        fs.writeFile(sansPath, Buffer.from(PT_SANS_BOLD_BASE64, 'base64')),
      ])

      const fontsConf = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontDir}</dir>
  <cachedir>${path.join(fontDir, 'cache')}</cachedir>
</fontconfig>`
      await fs.writeFile(confPath, fontsConf)

      process.env.FONTCONFIG_FILE = confPath
    })()
  }
  return fontsReadyPromise
}

/**
 * Pixel regions calibrated by sampling public/qr-card-template.png directly
 * (1024x1536 artwork): the LCD plaque where the hotel name sits, the
 * "ROOM ###" pill's digits, and the white card the QR code sits on. Everything
 * else in the template (handset, services list, RoomLink footer, hardware
 * details) is fixed artwork and rendered as-is.
 */
const HOTEL_NAME_BOX = { left: 375, top: 190, width: 530, height: 75 }
const HOTEL_NAME_BG = '#c4c7ae'
// Directly below the hotel name, same LCD sub-band the template's baked-in
// "— WELCOME —" subtitle occupies — sampled from the template artwork the
// same way HOTEL_NAME_BOX was. The LCD's inner bottom edge falls around
// y=339 (measured directly off the artwork pixels), so this has to fit in
// the ~68px between the hotel name box's bottom (265) and that edge.
const CONTACT_BRACKET_BOX = { left: 375, top: 266, width: 530, height: 66 }
const ROOM_NUMBER_BOX = { left: 650, top: 378, width: 76, height: 44 }
const ROOM_NUMBER_BG = '#c29a56'
const QR_BOX = { left: 332, top: 602, size: 340 }

function escapeXml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const HOTEL_NAME_MAX_FONT_SIZE = 44
const HOTEL_NAME_MIN_FONT_SIZE = 16
const HOTEL_NAME_LETTER_SPACING_RATIO = 6 / 44
const HOTEL_NAME_PADDING = 16

// Empirically measured against PT Serif Bold (rendered via sharp/librsvg
// and measured pixel-by-pixel): glyphWidth ≈ 0.66 * fontSize for this font.
// librsvg (sharp's SVG renderer) does NOT implement textLength/lengthAdjust
// — text silently overflows past it — so the font size has to be solved for
// directly instead of relying on the SVG spec's auto-fit attributes.
const GLYPH_WIDTH_RATIO = 0.66

function renderedWidth(length: number, fontSize: number) {
  return length * fontSize * GLYPH_WIDTH_RATIO + Math.max(0, length - 1) * fontSize * HOTEL_NAME_LETTER_SPACING_RATIO
}

/** Largest font size (up to the "designed" max) whose rendered width fits availableWidth at this length. */
function fitFontSize(length: number, availableWidth: number) {
  const denom = length * GLYPH_WIDTH_RATIO + Math.max(0, length - 1) * HOTEL_NAME_LETTER_SPACING_RATIO
  const fitted = denom > 0 ? availableWidth / denom : HOTEL_NAME_MAX_FONT_SIZE
  return Math.min(HOTEL_NAME_MAX_FONT_SIZE, Math.max(HOTEL_NAME_MIN_FONT_SIZE, fitted))
}

/**
 * Names that still wouldn't fit even at the minimum legible font size get
 * truncated with an ellipsis instead of clipping off-canvas — this is rare
 * (needs a ~35+ character name) but the LCD screen has a hard physical edge.
 */
function fitNameToBox(nameUpper: string, availableWidth: number) {
  if (renderedWidth(nameUpper.length, HOTEL_NAME_MIN_FONT_SIZE) <= availableWidth) {
    return { text: nameUpper, fontSize: fitFontSize(nameUpper.length, availableWidth) }
  }
  let truncated = nameUpper
  while (truncated.length > 1 && renderedWidth(truncated.length + 1, HOTEL_NAME_MIN_FONT_SIZE) > availableWidth) {
    truncated = truncated.slice(0, -1)
  }
  return { text: `${truncated.trimEnd()}…`, fontSize: HOTEL_NAME_MIN_FONT_SIZE }
}

// Reception and Room Service render inside one shared "bracket" panel (not
// two separate pills) — a single dark navy rounded rect, high-contrast
// against the LCD's light cream/sage background (a gold pill on that same
// cream was too close in tone to read as "highlighted"). Navy + gold
// mirrors the hotel name's own color pairing above it, so it reads as
// designed-in rather than pasted on.
const CONTACT_BRACKET_MAX_FONT_SIZE = 20
const CONTACT_BRACKET_MIN_FONT_SIZE = 13
const CONTACT_BRACKET_PADDING_X = 20
const CONTACT_BRACKET_ROW_HEIGHT = 24
// Doubles as the bracket's top/bottom internal padding (not just the gap
// between rows) — using one value for both is what makes the vertical
// rhythm read as evenly spaced: margin-row-gap-row-margin, all equal,
// rather than the rows sitting flush against the bracket's edges.
const CONTACT_BRACKET_ROW_GAP = 6
const CONTACT_BRACKET_RADIUS = 12
const CONTACT_BRACKET_BG = '#0c1628'
// White, same as the template's own "RESTAURANT"/"HOUSEKEEPING" service
// labels (sampled directly off the artwork) — matches the card's existing
// typography instead of introducing a different accent color.
const CONTACT_BRACKET_TEXT = '#ffffff'

// PT Sans Bold uppercase, no letter-spacing — same font/weight/case
// treatment as the template's own "RESTAURANT" service labels. Uppercase
// glyphs run wider than the mixed-case ratio used elsewhere in this file,
// hence the higher (still deliberately conservative, to avoid overflow
// rather than under-estimate it) glyph-width ratio.
const CONTACT_BRACKET_GLYPH_WIDTH_RATIO = 0.62

function contactBracketTextWidth(length: number, fontSize: number) {
  return length * fontSize * CONTACT_BRACKET_GLYPH_WIDTH_RATIO
}

/** Same fit-then-truncate approach as fitNameToBox, minus letter-spacing — `text` is expected pre-uppercased by the caller. */
function fitContactBracketLine(text: string, availableWidth: number) {
  if (contactBracketTextWidth(text.length, CONTACT_BRACKET_MIN_FONT_SIZE) <= availableWidth) {
    const fitted = availableWidth / (text.length * CONTACT_BRACKET_GLYPH_WIDTH_RATIO)
    return { text, fontSize: Math.min(CONTACT_BRACKET_MAX_FONT_SIZE, Math.max(CONTACT_BRACKET_MIN_FONT_SIZE, fitted)) }
  }
  // Still wouldn't fit even at the minimum legible size (an unusually long
  // number) — truncate with an ellipsis rather than overflow the LCD bezel.
  let truncated = text
  while (truncated.length > 1 && contactBracketTextWidth(truncated.length + 1, CONTACT_BRACKET_MIN_FONT_SIZE) > availableWidth) {
    truncated = truncated.slice(0, -1)
  }
  return { text: `${truncated.trimEnd()}…`, fontSize: CONTACT_BRACKET_MIN_FONT_SIZE }
}

/**
 * Renders Reception and Room Service together in one bracket panel. Returns
 * '' when both are null/empty (a hotel that predates these fields and
 * hasn't backfilled them yet) so the template's original baked-in
 * "WELCOME" subtitle is left alone. When only one is set, the bracket
 * shrinks to a single row rather than showing one blank row.
 */
function contactBracketSvg(receptionContact: string | null, roomServiceContact: string | null) {
  const lines = [
    receptionContact ? { label: 'Reception', contact: receptionContact } : null,
    roomServiceContact ? { label: 'Room Service', contact: roomServiceContact } : null,
  ].filter((line): line is { label: string; contact: string } => line !== null)

  if (lines.length === 0) return ''

  const box = CONTACT_BRACKET_BOX
  // margin-row-gap-row-…-margin: (N+1) equal gaps around N equal-height rows.
  const bracketHeight = lines.length * CONTACT_BRACKET_ROW_HEIGHT + (lines.length + 1) * CONTACT_BRACKET_ROW_GAP
  const bracketTop = box.top + (box.height - bracketHeight) / 2
  const availableWidth = box.width - CONTACT_BRACKET_PADDING_X * 2

  const rows = lines
    .map((line, i) => {
      const { text, fontSize } = fitContactBracketLine(`${line.label} : ${line.contact}`.toUpperCase(), availableWidth)
      const rowTop = bracketTop + CONTACT_BRACKET_ROW_GAP + i * (CONTACT_BRACKET_ROW_HEIGHT + CONTACT_BRACKET_ROW_GAP)
      const centerX = box.left + box.width / 2
      const centerY = rowTop + CONTACT_BRACKET_ROW_HEIGHT / 2 + fontSize * 0.34
      return `
    <text
      x="${centerX}" y="${centerY}"
      text-anchor="middle"
      font-family="PT Sans, Arial, Helvetica, sans-serif"
      font-size="${fontSize}"
      font-weight="700"
      fill="${CONTACT_BRACKET_TEXT}"
    >${escapeXml(text)}</text>`
    })
    .join('')

  return `
    <rect x="${box.left}" y="${bracketTop}" width="${box.width}" height="${bracketHeight}" rx="${CONTACT_BRACKET_RADIUS}" fill="${CONTACT_BRACKET_BG}" />${rows}`
}

function overlaySvg(
  hotelName: string,
  roomNumber: string,
  receptionContact: string | null,
  roomServiceContact: string | null
) {
  const availableWidth = HOTEL_NAME_BOX.width - HOTEL_NAME_PADDING * 2
  const { text: nameUpper, fontSize } = fitNameToBox(hotelName.toUpperCase(), availableWidth)
  const letterSpacing = fontSize * HOTEL_NAME_LETTER_SPACING_RATIO
  const nameCenterX = HOTEL_NAME_BOX.left + HOTEL_NAME_BOX.width / 2
  const nameCenterY = HOTEL_NAME_BOX.top + HOTEL_NAME_BOX.height / 2 + fontSize * 0.32

  // Left-aligned with a small inset (not centered in ROOM_NUMBER_BOX) so the
  // digits sit right after "ROOM" like the original artwork, regardless of
  // exactly how wide the rendered digits turn out to be.
  const roomTextX = ROOM_NUMBER_BOX.left + 4
  const roomCenterY = ROOM_NUMBER_BOX.top + ROOM_NUMBER_BOX.height / 2 + 10

  const contactBracket = contactBracketSvg(receptionContact, roomServiceContact)

  return `<svg width="${TEMPLATE_WIDTH}" height="${TEMPLATE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <filter id="patchBlend" x="-20%" y="-50%" width="140%" height="200%">
      <feGaussianBlur stdDeviation="3.5" />
    </filter>

    <rect x="${HOTEL_NAME_BOX.left}" y="${HOTEL_NAME_BOX.top}" width="${HOTEL_NAME_BOX.width}" height="${HOTEL_NAME_BOX.height}" fill="${HOTEL_NAME_BG}" filter="url(#patchBlend)" />
    <text
      x="${nameCenterX}" y="${nameCenterY}"
      text-anchor="middle"
      font-family="PT Serif, Georgia, serif"
      font-size="${fontSize}"
      font-weight="700"
      letter-spacing="${letterSpacing}"
      fill="#0c1628"
    >${escapeXml(nameUpper)}</text>
    ${contactBracket}

    <rect x="${ROOM_NUMBER_BOX.left}" y="${ROOM_NUMBER_BOX.top}" width="${ROOM_NUMBER_BOX.width}" height="${ROOM_NUMBER_BOX.height}" fill="${ROOM_NUMBER_BG}" filter="url(#patchBlend)" />
    <text
      x="${roomTextX}" y="${roomCenterY}"
      text-anchor="start"
      font-family="PT Sans, Arial, Helvetica, sans-serif"
      font-size="26"
      font-weight="700"
      fill="#0c0b09"
    >${escapeXml(roomNumber)}</text>
  </svg>`
}

/**
 * Composites the hotel's real name, the room number, and a room-specific QR
 * code onto the designer-provided phone-card template artwork, producing a
 * single print-ready PNG that matches the reference template exactly (same
 * handset, services list, and branding — only these three fields change).
 */
export async function generateRoomQrCardImage({
  hotelName,
  roomNumber,
  qrPayload,
  receptionContact = null,
  roomServiceContact = null,
}: {
  hotelName: string
  roomNumber: string
  qrPayload: string
  receptionContact?: string | null
  roomServiceContact?: string | null
}): Promise<Buffer> {
  await ensureFontsConfigured()

  const qrPng = await QRCode.toBuffer(qrPayload, { type: 'png', width: QR_BOX.size * 2, margin: 1 })
  const qrResized = await sharp(qrPng).resize(QR_BOX.size, QR_BOX.size).toBuffer()

  return sharp(TEMPLATE_BUFFER)
    .composite([
      { input: Buffer.from(overlaySvg(hotelName, roomNumber, receptionContact, roomServiceContact)), left: 0, top: 0 },
      { input: qrResized, left: QR_BOX.left, top: QR_BOX.top },
    ])
    .png()
    .withMetadata({ density: TEMPLATE_DPI })
    .toBuffer()
}
