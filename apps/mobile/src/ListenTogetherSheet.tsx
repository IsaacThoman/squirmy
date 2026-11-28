import { queryKeys, type JamInfo, type JamQueuePolicy, type JamRequest } from '@squirmy/contracts';
import { useQuery } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Share } from 'react-native';
import { useServerUrl, useSignedInApi } from './account/AccountProvider';
import { closeSheet } from './closeSheet';
import { announce } from './inlineFeedback';
import { jamFailure, usePlaybackState } from './playback';
import { jamIdFrom } from './player/jam';
import { SheetAction, SheetField, SheetFrame, SheetNote, SheetPickerRow, SheetRow, SheetRows } from './SheetUI';

const policies: readonly { value: JamQueuePolicy; label: string }[] = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'host', label: 'Only me' },
];

/**
 * Listen together: start a listening session and share it, join one from a link, or, in one,
 * see who listens and leave (or, as its host, invite people, choose who adds songs and end it).
 */
export function ListenTogetherSheet() {
  const router = useRouter();
  const { jam, canJam, detached, actions } = usePlaybackState();
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const run = async (key: string, request: JamRequest, then?: () => void) => {
    if (busy) return;
    void Haptics.selectionAsync();
    setBusy(key);
    setFailure(null);
    const result = await actions.jam(request);
    setBusy(null);
    if (!result.ok) {
      const message = jamFailure(result.error);
      setFailure(message);
      announce(message);
      return;
    }
    then?.();
  };
  const close = () => closeSheet(router);
  return (
    <SheetFrame title={jam ? 'Listening together' : 'Listen together'} onClose={close}>
      {!canJam
        ? <SheetNote>This server can’t listen together yet.</SheetNote>
        : jam
          ? <RunningJam jam={jam} busy={busy} run={run} onDone={close} />
          : <StartJam detached={detached} busy={busy} run={run} />}
      {failure && <SheetNote error>{failure}</SheetNote>}
    </SheetFrame>
  );
}

type Run = (key: string, request: JamRequest, then?: () => void) => Promise<void>;

function StartJam({ detached, busy, run }: { detached: boolean; busy: string | null; run: Run }) {
  const [link, setLink] = useState('');
  const join = () => {
    const jamId = jamIdFrom(link);
    if (!jamId) return Alert.alert('That isn’t an invite link', 'Paste the link someone shared with you.');
    void run('join', { action: 'join', jamId });
  };
  if (detached) return <SheetNote>This iPhone plays separately. Rejoin your other devices to listen together.</SheetNote>;
  return <>
    <SheetNote>Invite people on this server to hear what you play, each on their own device, in step. You choose what plays.</SheetNote>
    <SheetAction title={busy === 'start' ? 'Starting…' : 'Start listening together'} disabled={busy !== null} onPress={() => void run('start', { action: 'start' })} />
    <SheetField label="Paste an invite link to join" value={link} onChange={setLink} onSubmit={join} />
    {link.trim() !== '' && <SheetRows>
      <SheetRow title="Join" icon="person.2.fill" busy={busy === 'join'} onPress={join} />
    </SheetRows>}
  </>;
}

function RunningJam({ jam, busy, run, onDone }: { jam: JamInfo; busy: string | null; run: Run; onDone: () => void }) {
  const hosting = jam.role === 'host';
  const serverUrl = useServerUrl();
  const host = jam.members.find(member => member.userId === jam.hostUserId);
  const link = `${serverUrl.replace(/\/+$/, '')}/jam/${encodeURIComponent(jam.id)}`;
  const remove = (userId: string, name: string) => Alert.alert(`Remove ${name}?`, 'They stop hearing what you play.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Remove', style: 'destructive', onPress: () => void run(`remove:${userId}`, { action: 'remove', userId }) },
  ]);
  return <>
    <SheetNote>{hosting ? 'Everyone hears what you play.' : `You’re listening with ${host?.name ?? 'the host'}. They choose what plays.`}</SheetNote>
    <SheetRows>
      {jam.members.map(member => (
        <SheetRow key={member.userId} title={member.name} icon={member.userId === jam.hostUserId ? 'crown.fill' : 'person.crop.circle.fill'}
          subtitle={member.userId === jam.hostUserId ? 'Host' : hosting ? 'Tap to remove' : undefined}
          busy={busy === `remove:${member.userId}`}
          onPress={() => { if (hosting && member.userId !== jam.hostUserId) remove(member.userId, member.name); }} />
      ))}
    </SheetRows>
    {hosting && <>
      <SheetRows>
        <SheetRow title="Share invite link" icon="square.and.arrow.up" subtitle="Anyone with an account on this server can join"
          onPress={() => void Share.share({ message: link, url: link }).catch(() => undefined)} />
      </SheetRows>
      <InvitePeople jam={jam} busy={busy} run={run} />
      <SheetPickerRow label="Who can add songs" value={jam.queuePolicy} options={policies}
        onChange={queuePolicy => void run('settings', { action: 'settings', queuePolicy })} />
    </>}
    {!hosting && <SheetNote>{jam.queuePolicy === 'everyone' ? 'Anything you play is added to the queue for everyone.' : 'Only the host adds songs.'}</SheetNote>}
    <SheetRows>
      {hosting
        ? <SheetRow title="End for everyone" icon="stop.circle" destructive busy={busy === 'end'} onPress={() => void run('end', { action: 'end' }, onDone)} />
        : <SheetRow title="Leave" icon="rectangle.portrait.and.arrow.right" destructive busy={busy === 'leave'} onPress={() => void run('leave', { action: 'leave' }, onDone)} />}
    </SheetRows>
  </>;
}

/** The server's other people: each invited one gets the invite wherever they are signed in. */
function InvitePeople({ jam, busy, run }: { jam: JamInfo; busy: string | null; run: Run }) {
  const api = useSignedInApi();
  const people = useQuery({ queryKey: queryKeys.jamPeople(), queryFn: () => api!.sessions.jamPeople(), enabled: Boolean(api) });
  const [invited, setInvited] = useState<ReadonlySet<string>>(new Set());
  const listed = new Set(jam.members.map(member => member.userId));
  const others = (people.data?.items ?? []).filter(person => !listed.has(person.userId));
  if (!others.length) return null;
  return (
    <SheetRows>
      {others.map(person => (
        <SheetRow key={person.userId} title={`Invite ${person.name}`} icon={invited.has(person.userId) ? 'checkmark.circle' : 'person.crop.circle.badge.plus'}
          subtitle={invited.has(person.userId) ? 'Invited' : undefined} busy={busy === `invite:${person.userId}`}
          onPress={() => void run(`invite:${person.userId}`, { action: 'invite', userIds: [person.userId] }, () => setInvited(new Set([...invited, person.userId])))} />
      ))}
    </SheetRows>
  );
}
