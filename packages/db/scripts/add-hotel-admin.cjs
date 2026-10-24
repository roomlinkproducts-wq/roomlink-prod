// One-off script: adds a Hotel Admin user to an EXISTING hotel.
// Run from repo root: node packages/db/scripts/add-hotel-admin.cjs
//
// Idempotent: skips if a user with this email already exists.
// Reuses the hotel's "Hotel Admin" role if one already exists, else creates it.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const bcrypt = require('bcryptjs')
const { PrismaClient } = require('@prisma/client')

if (!process.env.DATABASE_URL) {
  const envPath = path.join(__dirname, '..', '.env')
  const envFile = fs.readFileSync(envPath, 'utf8')
  for (const line of envFile.split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (match) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '')
  }
}

const prisma = new PrismaClient()

const HOTEL_CODE = 'RL20260001'
const NEW_ADMIN = {
  fullName: 'Gurudutta Harichandan',
  email: 'guruduttaharichandan@gmail.com',
  phone: '6371268244',
}

function generateStrongPassword() {
  const words = ['Harbor', 'Lantern', 'Cedar', 'Comet', 'Marble', 'Falcon', 'Willow', 'Quartz']
  const word = words[crypto.randomBytes(1)[0] % words.length]
  const digits = crypto.randomBytes(3).readUIntBE(0, 3) % 100000
  const symbol = '!@#$%'[crypto.randomBytes(1)[0] % 5]
  return `${word}${digits}${symbol}`
}

async function main() {
  const hotel = await prisma.hotels.findUnique({ where: { hotel_code: HOTEL_CODE } })
  if (!hotel) {
    throw new Error(`No hotel found with hotel_code "${HOTEL_CODE}"`)
  }

  const existing = await prisma.users.findUnique({ where: { email: NEW_ADMIN.email } })
  if (existing) {
    console.log(`Skipped ${NEW_ADMIN.email} — a user with this email already exists.`)
    return
  }

  let role = await prisma.roles.findFirst({ where: { hotel_id: hotel.hotel_id, name: 'Hotel Admin' } })
  if (!role) {
    role = await prisma.roles.create({
      data: { hotel_id: hotel.hotel_id, name: 'Hotel Admin', is_system_role: false },
    })
    console.log(`Created "Hotel Admin" role for ${hotel.name} (${role.role_id})`)
  }

  const password = generateStrongPassword()
  const passwordHash = await bcrypt.hash(password, 10)

  const admin = await prisma.users.create({
    data: {
      hotel_id: hotel.hotel_id,
      role_id: role.role_id,
      user_type: 'hotel_admin',
      full_name: NEW_ADMIN.fullName,
      email: NEW_ADMIN.email,
      phone: NEW_ADMIN.phone,
      password_hash: passwordHash,
      // 'invited' would block login (authorize() requires status === 'active')
      // and there's no accept-invite flow — the temp password below is the activation step.
      status: 'active',
    },
  })

  console.log(`\nCreated hotel admin for ${hotel.name} (${HOTEL_CODE}):`)
  console.log(`  ${admin.full_name} <${admin.email}>  password: ${password}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
