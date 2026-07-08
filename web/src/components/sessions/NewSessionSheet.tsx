import { useState } from 'react';
import { useStore } from '../../state/store.js';
import { ModelPicker, AgentPicker } from '../controls/Pickers.js';

interface Props {
  onCreate: (opts: { cwd: string; agentId: string; modelId: string }) => void;
  onClose: () => void;
}

export function NewSessionSheet({ onCreate, onClose }: Props) {
  const models = useStore((s) => s.models);
  const [cwd, setCwd] = useState('');
  const [agentId, setAgentId] = useState('kiro_default');
  const [modelId, setModelId] = useState(
    models.find((m) => m.isDefault)?.modelId ?? 'auto',
  );

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2 className="sheet-title">New session</h2>

        <label className="picker">
          <span className="picker-label">Working directory</span>
          <input
            className="picker-input"
            value={cwd}
            placeholder="leave blank for server default"
            onChange={(e) => setCwd(e.target.value)}
          />
        </label>

        <AgentPicker value={agentId} onChange={setAgentId} />
        <ModelPicker value={modelId} onChange={setModelId} />

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
