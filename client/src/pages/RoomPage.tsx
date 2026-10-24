import { useParams } from 'react-router'

export default function RoomPage() {
  const { meetCode } = useParams()

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-3 px-6 py-16">
      <span className="label-caps">Meeting code</span>
      <p className="meet-code text-2xl">{meetCode}</p>
    </main>
  )
}
