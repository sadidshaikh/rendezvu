import { useCallback, useState } from 'react'
import { Link, useParams } from 'react-router'
import JoinMeet from '@/components/features/JoinMeet'
import MeetCall from '@/components/features/MeetCall'
import { Button } from '@/components/ui/button'
import { useCall } from '@/hooks/use-call'
import { useSignaling } from '@/hooks/use-signaling'
import { useJoinMeetStore } from '@/stores/join-meet'

type Stage = 'lobby' | 'call' | 'left'

export default function RoomPage() {
  const { meetCode = '' } = useParams()
  const userName = useJoinMeetStore((s) => s.userName)
  const setUserName = useJoinMeetStore((s) => s.setUserName)
  const [stage, setStage] = useState<Stage>('lobby')
  const [roomError, setRoomError] = useState<string | null>(null)

  const inCall = stage === 'call'
  const { client, connState } = useSignaling(inCall)

  const handleRoomError = useCallback((message: string) => {
    setRoomError(message)
    setStage('lobby')
  }, [])

  useCall({ client, roomId: meetCode, enabled: inCall, userName, onRoomError: handleRoomError })

  const handleJoin = (name: string) => {
    setUserName(name)
    setRoomError(null)
    setStage('call')
  }

  if (stage === 'call') {
    return <MeetCall meetCode={meetCode} userName={userName} connState={connState} onLeave={() => setStage('left')} />
  }

  if (stage === 'left') {
    return (
      <main className="call-stage flex min-h-screen flex-1 items-center justify-center p-6">
        <div className="experience-card w-full max-w-md p-8 text-center">
          <h1 tabIndex={-1} ref={(el) => el?.focus()} className="font-display text-3xl outline-none">
            You’ve left the call.
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Your camera and microphone are off. You can rejoin if the room is still open.
          </p>
          <Button className="mt-6 w-full" onClick={() => setStage('lobby')}>
            Rejoin call
          </Button>
          <Link className="mt-4 inline-block text-sm text-primary" to="/">
            Back to Rendezvu
          </Link>
        </div>
      </main>
    )
  }

  return <JoinMeet meetCode={meetCode} roomError={roomError} onJoin={handleJoin} />
}
