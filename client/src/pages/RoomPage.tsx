import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import JoinMeet from '@/components/features/JoinMeet'
import MeetCall from '@/components/features/MeetCall'
import { Button } from '@/components/ui/button'
import { CallErrorBoundary } from '@/components/ui/CallErrorBoundary'
import { useCall } from '@/hooks/use-call'
import { useSignaling } from '@/hooks/use-signaling'
import { useJoinMeetStore } from '@/stores/join-meet'
import { useMeetStore } from '@/stores/meet'
import { usePeerStore } from '@/stores/peer'

type Stage = 'lobby' | 'call' | 'left'

/** Stops the camera and mic and resets the toggles to off. */
function releaseMedia() {
  usePeerStore.getState().clearAll()
  useMeetStore.getState().clearMeet()
}

export default function RoomPage() {
  const { meetCode = '' } = useParams()
  const userName = useJoinMeetStore((s) => s.userName)
  const setUserName = useJoinMeetStore((s) => s.setUserName)
  const isMuted = useMeetStore((s) => s.isMuted)
  const isVideoOff = useMeetStore((s) => s.isVideoOff)
  const [stage, setStage] = useState<Stage>('lobby')
  const [roomError, setRoomError] = useState<string | null>(null)

  const inCall = stage === 'call'
  const { client, connState, reconnectAttempt } = useSignaling(inCall)

  // Media keeps running from lobby to call; it is released when the user
  // leaves, or navigates away from the room page altogether.
  useEffect(() => releaseMedia, [])

  const handleRoomError = useCallback((message: string) => {
    setRoomError(message)
    setStage('lobby')
  }, [])

  useCall({
    client,
    roomId: meetCode,
    enabled: inCall,
    userName,
    initialAudio: !isMuted,
    initialVideo: !isVideoOff,
    onRoomError: handleRoomError,
  })

  const handleJoin = (name: string) => {
    setUserName(name)
    setRoomError(null)
    setStage('call')
  }

  const handleLeave = () => {
    setStage('left')
    releaseMedia()
  }

  if (stage === 'call') {
    return (
      <CallErrorBoundary onLeave={handleLeave}>
        <MeetCall
          meetCode={meetCode}
          userName={userName}
          client={client}
          connState={connState}
          reconnectAttempt={reconnectAttempt}
          onLeave={handleLeave}
        />
      </CallErrorBoundary>
    )
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
