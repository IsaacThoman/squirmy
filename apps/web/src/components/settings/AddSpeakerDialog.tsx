import { PairingUserCode } from '@squirmy/contracts'
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/input'

/**
 * Settings → Security → Add a speaker: takes the code a Squirmy speaker (`apps/speaker`) shows
 * and hands it to the pairing page, which looks it up and asks before signing the speaker in,
 * exactly as for an Apple TV.
 */
export function AddSpeakerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate()
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setInput('')
      setError('')
    }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const code = PairingUserCode.safeParse(input)
    if (!code.success) return setError('Enter the eight characters the speaker shows.')
    close(false)
    void navigate(`/pair?code=${code.data}`)
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        title="Add a speaker"
        description="Squirmy speaker plays your music on a Raspberry Pi or another Linux computer with speakers. When it starts, it shows a code in its log and on its status page, at port 4790 of its address."
      >
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Field label="Speaker code" htmlFor="speaker-code" error={error}>
            <Input id="speaker-code" value={input} maxLength={9} autoCapitalize="characters" autoComplete="off" spellCheck={false} autoFocus
              aria-invalid={!!error} onChange={event => { setInput(event.target.value); setError('') }} />
          </Field>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
            <Button type="submit" variant="primary" disabled={!input.trim()}>Continue</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
