import { PrintButton } from './print-button'

export function RoomQrCard({
  hotelName,
  roomNumber,
  imageSrc,
}: {
  hotelName: string
  roomNumber: string
  imageSrc: string
}) {
  return (
    <div className="flex min-h-screen flex-col items-center gap-5 bg-slate-100 py-10 print:block print:min-h-0 print:bg-white print:py-0">
      <style>{`
        @media print {
          @page { size: 4in 6in; margin: 0; }
          html, body { margin: 0; }
          .no-print { display: none !important; }
        }
      `}</style>

      <div className="no-print flex gap-3">
        <PrintButton />
        <a
          href={`${imageSrc}?download=true`}
          download={`room-${roomNumber}-qr-card.png`}
          className="rounded-md border border-slate-300 bg-white px-5 py-2.5 text-sm font-medium text-slate-700 shadow hover:bg-slate-50"
        >
          Download Image (PNG)
        </a>
      </div>

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imageSrc}
        alt={`${hotelName} — Room ${roomNumber} QR card`}
        className="h-[6in] w-[4in] rounded-2xl object-cover shadow-2xl print:rounded-none print:shadow-none"
      />
    </div>
  )
}
