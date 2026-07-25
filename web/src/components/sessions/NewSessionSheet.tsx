import { useState } from 'react';
import { useStore } from '../../state/store.js';
import { ModelPicker, AgentPicker } from '../controls/Pickers.js';
import { CwdField } from './CwdField.js';

interface Props {
  onCreate: (opts: { cwd: string; agentId: string; modelId: string }) => void;
  onClose: () => void;
}

export function NewSessionSheet({ onCreate, onClose }: Props) {
  const models = useStore((s) => s.models);
  const defaultAgentId = useStore((s) => s.defaultAgentId);
  const [cwd, setCwd] = useState('');
  const [agentOverride, setAgentOverride] = useState<string>();
  const [modelOverride, setModelOverride] = useState<string>();
  const agentId = agentOverride ?? defaultAgentId;
  const modelId =
    modelOverride ?? models.find((m) => m.isDefault)?.modelId ?? 'auto';

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2 className="sheet-title">New session</h2>

        <CwdField value={cwd} onChange={setCwd} />

        <AgentPicker value={agentId} onChange={setAgentOverride} />
        <ModelPicker value={modelId} onChange={setModelOverride} />

        <div className="sheet-actions">
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => onCreate({ cwd: cwd.trim(), agentId, modelId })}
          >
            Start session
          </button>
        </div>
      </div>
    </div>
  );
}
