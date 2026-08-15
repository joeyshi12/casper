import { useStore } from '../../state/store.js';
import { Dropdown } from '../common/Dropdown.js';

interface ModelPickerProps {
  value?: string;
  onChange: (modelId: string) => void;
}

/** Model selector - shows the credit multiplier so cost is visible at choice time. */
export function ModelPicker({ value, onChange }: ModelPickerProps) {
  const models = useStore((s) => s.models);
  // Nothing selected means the session will use the server's default, so name it
  // instead of showing an empty picker.
  const shown = value ?? models.find((m) => m.isDefault)?.modelId;
  return (
    <Dropdown
      ariaLabel="Model"
      value={shown}
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
  const defaultAgentId = useStore((s) => s.defaultAgentId);
  const list = sessionModes.length > 0 ? sessionModes : globalAgents;
  const shown = value ?? defaultAgentId;
  return (
    <Dropdown
      ariaLabel="Agent"
      value={shown}
      onChange={onChange}
      options={list.map((m) => ({ value: m.id, label: m.name }))}
    />
  );
}
