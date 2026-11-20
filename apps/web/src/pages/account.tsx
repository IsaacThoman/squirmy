import type { AppPassword, UserSettings } from '@squirmy/contracts'
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { LoginView, RegisterView, SetupView } from '@/components/auth/AuthViews'
import { SettingsView } from '@/components/views/SettingsView'
import { appPasswords as initialPasswords, currentUser, serverSettings, userSettings } from '@/fixtures/server'
import { toast } from '@/lib/toast'

export function SettingsPage() {
  const navigate = useNavigate()
  const [settings, setSettings] = useState<UserSettings>(userSettings)
  const [passwords, setPasswords] = useState<AppPassword[]>(initialPasswords)
  return (
    <SettingsView
      user={currentUser}
      settings={settings}
      onSettingsChange={patch => setSettings(current => ({ ...current, ...patch }))}
      appPasswords={passwords}
      onCreateAppPassword={name => {
        const created: AppPassword = { id: crypto.randomUUID(), name, createdAt: new Date().toISOString(), lastUsedAt: null, secret: 'sq-4f9k-2m8x-7qpl-vw3d' }
        setPasswords(current => [...current, { ...created, secret: undefined }])
        return created
      }}
      onRevokeAppPassword={id => setPasswords(current => current.filter(password => password.id !== id))}
      onChangePassword={() => toast({ title: 'Changing your password needs the server' })}
      onLogout={() => navigate('/login')}
    />
  )
}

export function LoginPage() {
  const navigate = useNavigate()
  return <LoginView serverName={serverSettings.serverName} onSubmit={() => navigate('/')} />
}

export function RegisterPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  return <RegisterView serverName={serverSettings.serverName} inviteCode={params.get('invite') ?? ''} onSubmit={() => navigate('/')} />
}

export function SetupPage() {
  const navigate = useNavigate()
  return <SetupView onCreateAdmin={() => {}} onAddFolder={() => {}} onFinish={() => navigate('/')} />
}
