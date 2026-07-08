import { useStore } from '../../state/store.js';
import { Dropdown } from '../common/Dropdown.js';

interface ModelPickerProps {
  value?: string;
  onChange: (modelId: string) => void;
}

/** Model selector - shows the credit multiplier so cost is visible at choice time. */
export function ModelPicker({ value, onChange }: ModelPickerProps) {
  const models = useStore((s) => s.models);
  return (
    <Dropdown
      label="Model"
      value={value}
      onChange={onChange}
      options={models.map((m) => ({
        value: m.modelId,
        label: m.modelName,
        hint: `${m.rateMultiplier}x`,
      }))}
    />
  );
}

interface AgentPickerProps {
  value?: string;
  onChange: (modeId: string) => void;
}

/**
 * Agent selector. Prefers the live session's available modes, but falls back to
 * the global agent list (from /api/agents) so it's always populated - even
 * before a session has spawned a process.
 */
export function AgentPicker({ value, onChange }: AgentPickerProps) {
  const sessionModes = useStore((s) => s.modes);
  const globalAgents = useStore((s) => s.agents);
  const list = sessionModes.length > 0 ? sessionModes : globalAgents;
  return (
    <Dropdown
      label="Agent"
      value={value}
      onChange={onChange}
      options={list.map((m) => ({ value: m.id, label: m.name }))}
    />
  );
}
