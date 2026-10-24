import { useState, type ComponentProps } from 'react'
import { useNavigate } from 'react-router'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { createMeet } from '@/services/api/meet'
import { roomPath } from '@/lib/room-routes'

export function NewMeetingButton(props: Omit<ComponentProps<typeof Button>, 'onClick'>) {
  const navigate = useNavigate()
  const [isCreating, setIsCreating] = useState(false)

  const requestNewMeet = async () => {
    if (isCreating) return
    setIsCreating(true)
    try {
      const meet = await createMeet()
      navigate(roomPath(meet.meetCode))
    } catch {
      toast.error('Could not create meeting. Please try again.')
      setIsCreating(false)
    }
  }

  return (
    <Button onClick={requestNewMeet} aria-busy={isCreating} {...props} disabled={isCreating || props.disabled}>
      {isCreating && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
      {isCreating ? 'Creating...' : 'New meeting'}
    </Button>
  )
}
