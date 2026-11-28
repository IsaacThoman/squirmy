import { UpdateIntegrationConfig, type IntegrationConfig } from '@squirmy/contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useFormSubmit } from '@/api/errors'
import { useApi } from '@/api/services'
import { WebhookSettings } from '@/components/integrations/WebhookSettings'
import { Button } from '@/components/ui/button'
import { Field, FormError, Input } from '@/components/ui/input'
import { loadFailure } from '@/components/ui/load-failure'
import { Row, Section } from '@/components/ui/section'
import { Switch } from '@/components/ui/switch'
import { formatRelative } from '@/lib/format'

const configKey = ['integrations', 'config'] as const

export function IntegrationsAdmin() {
  const api = useApi().integrations
  const client = useQueryClient()
  const config = useQuery({ queryKey: configKey, queryFn: api.config })
  const deliveries = useQuery({ queryKey: ['integrations', 'deliveries'], queryFn: api.deliveries, refetchInterval: 3000 })
  return (
    <div className="space-y-6">
      <WebhookSettings admin />
      <Section title="Delivery log" description="The latest 100 deliveries across this server.">
        {loadFailure(deliveries, 'The delivery log did not load')}
        {deliveries.data?.length === 0 && <p className="text-sm text-muted-foreground">No deliveries yet.</p>}
        {deliveries.data?.map(delivery => (
          <Row key={delivery.id} label={delivery.name} description={`${delivery.event} · ${delivery.attempts} attempts · ${formatRelative(delivery.updatedAt)}`}>
            <span className="text-sm capitalize">{delivery.status}{delivery.httpStatus ? ` · HTTP ${delivery.httpStatus}` : ''}</span>
          </Row>
        ))}
      </Section>
      {loadFailure(config, 'Integration settings did not load')}
      {config.data && <BrokerSettings config={config.data} onSave={async body => {
        client.setQueryData(configKey, await api.saveConfig(body))
      }} />}
    </div>
  )
}

function BrokerSettings({ config, onSave }: { config: IntegrationConfig; onSave: (body: UpdateIntegrationConfig) => Promise<void> }) {
  const [allowLan, setAllowLan] = useState(config.allowLan)
  const [enabled, setEnabled] = useState(!!config.mqtt)
  const [url, setUrl] = useState(config.mqtt?.url ?? '')
  const [username, setUsername] = useState(config.mqtt?.username ?? '')
  const [password, setPassword] = useState('')
  const [topicPrefix, setTopicPrefix] = useState(config.mqtt?.topicPrefix ?? 'squirmy')
  const [saved, setSaved] = useState(false)
  const form = useFormSubmit(UpdateIntegrationConfig, async body => {
    await onSave(body)
    setPassword('')
    setSaved(true)
  })
  return (
    <Section title="Connection settings">
      <form className="space-y-4" onSubmit={event => {
        event.preventDefault()
        setSaved(false)
        void form.submit({ allowLan, mqtt: enabled ? { url, username: username || undefined, password: password || undefined, topicPrefix } : null })
      }}>
        <Row label="Allow local HTTP destinations" description="Allow webhook and custom ListenBrainz requests to reach RFC1918 networks.">
          <Switch aria-label="Allow local HTTP destinations" checked={allowLan} onCheckedChange={setAllowLan} />
        </Row>
        <Row label="MQTT" description="Publish now playing and accept commands from your broker.">
          <Switch aria-label="Enable MQTT" checked={enabled} onCheckedChange={setEnabled} />
        </Row>
        {enabled && <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Broker URL" htmlFor="mqtt-url">
            <Input id="mqtt-url" type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="mqtts://broker.example:8883" required />
          </Field>
          <Field label="Topic prefix" htmlFor="mqtt-topic">
            <Input id="mqtt-topic" value={topicPrefix} onChange={event => setTopicPrefix(event.target.value)} required />
          </Field>
          <Field label="Username" htmlFor="mqtt-user">
            <Input id="mqtt-user" value={username} onChange={event => setUsername(event.target.value)} />
          </Field>
          <Field label="Password" htmlFor="mqtt-password">
            <Input id="mqtt-password" type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} placeholder={config.mqtt?.passwordSet ? 'Password saved' : undefined} />
          </Field>
        </div>}
        <FormError message={form.errors.mqtt ?? form.errors.form} />
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" pending={form.pending}>Save settings</Button>
          {saved && <span role="status" className="text-sm text-muted-foreground">Settings saved.</span>}
        </div>
      </form>
    </Section>
  )
}
