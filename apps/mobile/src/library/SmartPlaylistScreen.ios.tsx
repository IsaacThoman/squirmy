import { Button, Form, Host, HStack, ProgressView, Section, Spacer, Text, TextField, Toggle, VStack, useNativeState } from '@expo/ui/swift-ui';
import {
  accessibilityLabel, disabled, font, foregroundStyle, keyboardType, scrollContentBackground, scrollDismissesKeyboard, tint,
} from '@expo/ui/swift-ui/modifiers';
import {
  booleanOptions, decadeOptions, fieldInfo, fieldOptions, isDraftGroup, matchOptions, operatorOptions, sortOptions, sourceOptions, unitOptions, withField,
  type DraftCondition,
} from '@squirmy/client-core';
import { PLAYLIST_NAME_MAX_LENGTH, type PlaylistDetail, type PlaylistSummary } from '@squirmy/contracts';
import { StyleSheet } from 'react-native';
import { useRatingsEnabled } from '../data/queries';
import { SheetFormHeader, SheetPickerRow } from '../SheetUI';
import { useColors } from '../theme';
import { useSmartPlaylistEditor } from './smartPlaylist';

/** Says "all rules" rather than the web's inline "all". */
const matchChoices = matchOptions.map(option => ({ ...option, label: option.value === 'all' ? 'All rules' : 'Any rule' }));

/**
 * A smart playlist's name, description, rules and visibility, in the sheet's form style: the
 * web's rule editor, one section per rule. `playlist` is the one being edited.
 */
export function SmartPlaylistForm({ playlist, onClose, onSaved }: {
  playlist?: PlaylistDetail; onClose: () => void; onSaved: (playlist: PlaylistSummary) => void;
}) {
  const colors = useColors();
  const editor = useSmartPlaylistEditor(playlist, onSaved);
  const ratings = useRatingsEnabled();
  const { draft } = editor;
  return <Host style={styles.page}>
    <VStack spacing={0}>
      <SheetFormHeader title={playlist ? 'Edit Smart Playlist' : 'New Smart Playlist'} onClose={onClose} />
      {/* A number pad has no return key: scrolling the form puts the keyboard away. */}
      <Form modifiers={[scrollContentBackground('hidden'), tint(colors.accent), scrollDismissesKeyboard('immediately')]}>
        <Section footer={playlist ? undefined : <Text>Its songs come from rules, and it keeps up as your music changes.</Text>}>
          <Field label="Name" value={editor.name} onChange={editor.setName} maxLength={PLAYLIST_NAME_MAX_LENGTH} />
          <Field label="Description (optional)" value={editor.description} onChange={editor.setDescription} maxLength={2000} />
        </Section>
        <Section title="Rules" footer={<Text>{draft.rules.length ? editor.matchCount
          : `No rules: every song ${draft.source === 'library' ? 'in your library' : 'on this server'}. ${editor.matchCount}`}</Text>}>
          <SheetPickerRow label="Songs from" value={draft.source} options={sourceOptions} onChange={source => editor.change({ source })} />
          <SheetPickerRow label="Match" value={draft.match} options={matchChoices} onChange={match => editor.change({ match })} />
        </Section>
        {draft.rules.map((rule, index) => isDraftGroup(rule)
          ? <Section key={rule.key} title={`Rule ${index + 1}: a group`}>
            <SheetPickerRow label="Match" value={rule.match} options={matchChoices} onChange={match => editor.changeRule(rule.key, () => ({ ...rule, match }))} />
            {rule.conditions.map(condition => <Condition key={condition.key} condition={condition} ratings={ratings}
              unfinished={editor.unfinished.has(condition.key)} onChange={next => editor.changeCondition(rule.key, condition.key, next)} />)}
            <Button label="Add Rule to Group" systemImage="plus" onPress={() => editor.addToGroup(rule.key)} modifiers={[disabled(!editor.canAdd)]} />
            <Button label="Remove Group" systemImage="trash" role="destructive" onPress={() => editor.removeRule(rule.key)} />
          </Section>
          : <Section key={rule.key} title={`Rule ${index + 1}`}>
            <Condition condition={rule} ratings={ratings} unfinished={editor.unfinished.has(rule.key)}
              onChange={next => editor.changeCondition(null, rule.key, next)} />
          </Section>)}
        <Section>
          <Button label="Add Rule" systemImage="plus" onPress={editor.addRule} modifiers={[disabled(!editor.canAdd)]} />
          <Button label="Add Group" systemImage="plus.square.on.square" onPress={editor.addGroup} modifiers={[disabled(!editor.canAdd)]} />
        </Section>
        <Section footer={editor.badLimit ? <Text modifiers={[foregroundStyle(colors.danger)]}>A whole number of songs</Text> : undefined}>
          <SheetPickerRow label="Order" value={draft.sort} options={sortOptions} onChange={sort => editor.change({ sort })} />
          <Field label="Limit (songs, optional)" value={draft.limit} onChange={limit => editor.change({ limit })} numeric />
        </Section>
        <Section footer={<Text>Other members see the songs your rules find for you.</Text>}>
          <Toggle label="Visible to everyone on this server" isOn={editor.isPublic} onIsOnChange={editor.setPublic} />
        </Section>
        <Section footer={editor.failure ? <Text modifiers={[foregroundStyle(colors.danger)]}>{editor.failure}</Text>
          : editor.unfinished.size ? <Text modifiers={[foregroundStyle(colors.danger)]}>Finish the marked rules, or remove them.</Text> : undefined}>
          <HStack>
            <Button label={playlist ? 'Save' : 'Create'} onPress={() => void editor.save()}
              modifiers={[disabled(!editor.name.trim() || editor.saving), font({ textStyle: 'body', weight: 'semibold' })]} />
            <Spacer />
            {editor.saving && <ProgressView />}
          </HStack>
        </Section>
      </Form>
    </VStack>
  </Host>;
}

/** One rule: its field, how it compares, the value, and Remove. */
function Condition({ condition, ratings, unfinished, onChange }: {
  condition: DraftCondition; ratings: boolean; unfinished: boolean; onChange: (next: DraftCondition | null) => void;
}) {
  const colors = useColors();
  const info = fieldInfo[condition.field];
  const operators = operatorOptions(condition.field);
  const set = (next: Partial<DraftCondition>) => onChange({ ...condition, ...next });
  const unit = info.unit ? ` (${info.unit})` : '';
  const dateCount = info.kind === 'date' && (condition.op === 'inLast' || condition.op === 'notInLast');
  return <>
    <SheetPickerRow label="Field" value={condition.field} options={fieldOptions(ratings, condition.field)} onChange={field => onChange(withField(condition, field))} />
    {operators.length > 0 && <SheetPickerRow label="Condition" value={condition.op} options={operators} onChange={op => set({ op })} />}
    {info.kind === 'decade' ? <SheetPickerRow label="Decade" value={condition.value} options={decadeOptions} onChange={value => set({ value })} />
      : info.kind === 'boolean' ? <SheetPickerRow label="Value" value={condition.value as 'true' | 'false'} options={booleanOptions} onChange={value => set({ value })} />
        : <Field key={`${condition.key}:${condition.field}:${condition.op}`} label={info.kind === 'date' && !dateCount ? 'Date (YYYY-MM-DD)' : `Value${unit}`}
          value={condition.value} onChange={value => set({ value })} numeric={info.kind === 'number' || dateCount} />}
    {info.kind === 'number' && condition.op === 'between' && <Field key={`${condition.key}:to`} label={`To${unit}`} value={condition.to}
      onChange={to => set({ to })} numeric />}
    {dateCount && <SheetPickerRow label="Unit" value={condition.unit} options={unitOptions} onChange={unit => set({ unit })} />}
    {unfinished && <Text modifiers={[font({ textStyle: 'footnote', weight: 'semibold' }), foregroundStyle(colors.danger)]}>Finish this rule</Text>}
    <Button label="Remove Rule" systemImage="minus.circle" role="destructive" onPress={() => onChange(null)}
      modifiers={[accessibilityLabel(`Remove rule, ${info.label}`)]} />
  </>;
}

/** A text field of the form, its label as the placeholder. */
function Field({ label, value, onChange, maxLength, numeric }: {
  label: string; value: string; onChange: (value: string) => void; maxLength?: number; numeric?: boolean;
}) {
  const text = useNativeState(value);
  return <TextField text={text} onTextChange={onChange} placeholder={label} maxLength={maxLength}
    modifiers={[accessibilityLabel(label), ...(numeric ? [keyboardType('decimal-pad')] : [])]} />;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
});
