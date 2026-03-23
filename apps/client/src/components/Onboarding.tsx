import { useApi } from '../hooks/useApi';
import { CheckCircle, XCircle, AlertCircle, Zap, ArrowRight, BarChart2, Brain, Shield, Terminal, Link2 } from 'lucide-react';

interface MCPToolStatus {
    tool: string;
    configured: boolean;
}

interface OnboardingProps {
    onDismiss: () => void;
}

export default function Onboarding({ onDismiss }: OnboardingProps) {
    const { data: overview } = useApi<any>('/api/overview');
    const { data: mcpStatus } = useApi<any>('/api/mcp-status');

    const tools = overview?.tools || [];
    const totalSessions = overview?.global?.total_sessions || 0;

    const knownTools = [
        { id: 'claude-code', label: 'Claude Code', path: '~/.claude/projects/' },
        { id: 'cursor', label: 'Cursor', path: 'state.vscdb' },
        { id: 'aider', label: 'Aider', path: '.aider.chat.history.md' },
        { id: 'windsurf', label: 'Windsurf', path: 'Codeium DB' },
        { id: 'copilot', label: 'GitHub Copilot', path: 'VS Code telemetry' },
        { id: 'continue', label: 'Continue.dev', path: '~/.continue/sessions/' },
        { id: 'antigravity', label: 'Gemini CLI', path: '~/.gemini/antigravity/' },
    ];

    const detectedTools = knownTools.filter(t => tools.some((s: any) => s.tool_id === t.id));
    const missingTools = knownTools.filter(t => !tools.some((s: any) => s.tool_id === t.id));

    const mcpTools = mcpStatus?.tools || [];
    const mcpConfigured = mcpStatus?.any_configured || false;

    const readinessLevel = totalSessions >= 50 ? 'full' : totalSessions >= 20 ? 'moderate' : totalSessions >= 5 ? 'basic' : 'empty';
    const readinessMap = {
        full: { label: 'Full Insights Available', color: 'text-neonGreen', desc: 'Semantic memory, routing recommendations, prompt science, and trend analysis are all active. Check Insights → Memory to see your embedding coverage.' },
        moderate: { label: 'Getting Useful', color: 'text-brand', desc: `${totalSessions} sessions tracked and embedded. Need ~${50 - totalSessions} more for full routing recommendations. Semantic search is already working.` },
        basic: { label: 'Warming Up', color: 'text-yellow-400', desc: `${totalSessions} sessions tracked. Embeddings are being generated automatically. Need ~${20 - totalSessions} more for trend analysis.` },
        empty: { label: 'Just Getting Started', color: 'text-zinc-400', desc: 'Use your AI tools normally. OCD collects data and generates semantic embeddings in the background — no action needed.' },
    };
    const readiness = readinessMap[readinessLevel];

    return (
        <div className="max-w-2xl mx-auto space-y-8">
            {/* Header */}
            <div className="text-center">
                <h2 className="text-4xl font-black text-transparent bg-clip-text bg-gradient-to-r from-brand to-neonPink">
                    Welcome to OCD
                </h2>
                <p className="text-sm text-zinc-400 mt-3 max-w-md mx-auto">
                    A self-building brain across all your AI coding tools. Real semantic memory, cross-tool routing, and proactive error detection — all 100% local.
                </p>
            </div>

            {/* Tool Detection */}
            <div className="glass-panel p-6">
                <h3 className="text-xs font-black text-zinc-400 mb-4 uppercase tracking-widest">Detected AI Tools</h3>
                <div className="space-y-2">
                    {detectedTools.map(t => (
                        <div key={t.id} className="flex items-center gap-3 p-3 bg-neonGreen/5 rounded-lg border border-neonGreen/20">
                            <CheckCircle className="w-4 h-4 text-neonGreen shrink-0" />
                            <span className="text-sm font-bold text-white">{t.label}</span>
                            <span className="text-[10px] text-zinc-500 ml-auto">{tools.find((s: any) => s.tool_id === t.id)?.sessions || 0} sessions</span>
                        </div>
                    ))}
                    {detectedTools.length === 0 && (
                        <div className="flex items-center gap-3 p-3 bg-yellow-400/5 rounded-lg border border-yellow-400/20">
                            <AlertCircle className="w-4 h-4 text-yellow-400 shrink-0" />
                            <span className="text-sm text-zinc-400">No AI tools detected yet. Use Claude Code, Cursor, or Aider and refresh.</span>
                        </div>
                    )}
                </div>
                {missingTools.length > 0 && detectedTools.length > 0 && (
                    <details className="mt-3">
                        <summary className="text-[10px] text-zinc-600 cursor-pointer hover:text-zinc-400 uppercase tracking-widest">
                            {missingTools.length} other supported tools
                        </summary>
                        <div className="mt-2 space-y-1">
                            {missingTools.map(t => (
                                <div key={t.id} className="flex items-center gap-3 p-2 rounded">
                                    <XCircle className="w-3.5 h-3.5 text-zinc-600 shrink-0" />
                                    <span className="text-xs text-zinc-500">{t.label}</span>
                                    <span className="text-[9px] text-zinc-700 ml-auto font-mono">{t.path}</span>
                                </div>
                            ))}
                        </div>
                    </details>
                )}
            </div>

            {/* MCP Connection Status */}
            <div className="glass-panel p-6">
                <h3 className="text-xs font-black text-zinc-400 mb-4 uppercase tracking-widest">
                    <Link2 className="w-3.5 h-3.5 inline mr-2 -mt-0.5" />
                    MCP Server — 18 Agent Tools
                </h3>
                {mcpConfigured ? (
                    <div className="space-y-2">
                        {mcpTools.map((t: MCPToolStatus) => (
                            <div key={t.tool} className={`flex items-center gap-3 p-3 rounded-lg border ${t.configured ? 'bg-neonGreen/5 border-neonGreen/20' : 'bg-[#050505] border-[#222]'}`}>
                                {t.configured ? <CheckCircle className="w-4 h-4 text-neonGreen shrink-0" /> : <XCircle className="w-3.5 h-3.5 text-zinc-600 shrink-0" />}
                                <span className={`text-sm font-bold ${t.configured ? 'text-white' : 'text-zinc-500'}`}>{t.tool}</span>
                                <span className="text-[10px] text-zinc-500 ml-auto">{t.configured ? 'Connected' : 'Not configured'}</span>
                            </div>
                        ))}
                        <p className="text-[10px] text-neonGreen mt-2">Your AI agents can now call 18 MCP tools: semantic search, health checks, routing, anti-hallucination, and more.</p>
                    </div>
                ) : (
                    <div>
                        <div className="flex items-center gap-3 p-3 bg-yellow-400/5 rounded-lg border border-yellow-400/20">
                            <AlertCircle className="w-4 h-4 text-yellow-400 shrink-0" />
                            <div>
                                <p className="text-sm text-zinc-300">MCP not configured yet</p>
                                <p className="text-[10px] text-zinc-500 mt-1">Run this to connect your AI tools to OCD's 18 agent tools:</p>
                            </div>
                        </div>
                        <div className="mt-3 p-3 bg-[#050505] rounded-lg border border-[#222]">
                            <code className="text-xs text-brand font-mono">npx omni-coder-dashboard --setup-mcp</code>
                        </div>
                        <p className="text-[10px] text-zinc-600 mt-2">This auto-configures Claude Code, Cursor, and Windsurf. Takes 5 seconds.</p>
                    </div>
                )}
            </div>

            {/* Data Readiness */}
            <div className="glass-panel p-6">
                <h3 className="text-xs font-black text-zinc-400 mb-4 uppercase tracking-widest">Data Readiness</h3>
                <div className="flex items-center gap-3 mb-4">
                    <span className={`text-lg font-black ${readiness.color}`}>{readiness.label}</span>
                </div>
                <p className="text-sm text-zinc-400">{readiness.desc}</p>
                {/* Progress bar */}
                <div className="mt-4">
                    <div className="flex justify-between text-[9px] text-zinc-600 font-bold uppercase tracking-widest mb-1">
                        <span>0</span>
                        <span>20 (trends + memory)</span>
                        <span>50 (full routing)</span>
                    </div>
                    <div className="w-full h-2 bg-[#111] rounded-full overflow-hidden border border-[#222]">
                        <div className="h-full bg-gradient-to-r from-brand to-neonGreen rounded-full transition-all duration-1000"
                            style={{ width: `${Math.min(100, (totalSessions / 50) * 100)}%` }} />
                    </div>
                    <p className="text-[10px] text-zinc-600 mt-1">{totalSessions} / 50 sessions</p>
                </div>
            </div>

            {/* What OCD Does For You */}
            <div className="glass-panel p-6">
                <h3 className="text-xs font-black text-zinc-400 mb-4 uppercase tracking-widest">What OCD Does For You</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="p-4 bg-[#050505] rounded-xl border border-[#222]">
                        <Brain className="w-5 h-5 text-neonPink mb-2" />
                        <p className="text-xs font-bold text-white">Semantic Memory</p>
                        <p className="text-[10px] text-zinc-500 mt-1">Every session is vectorized with a local ONNX model. Solutions from Claude Code surface in Cursor — no API keys needed.</p>
                    </div>
                    <div className="p-4 bg-[#050505] rounded-xl border border-[#222]">
                        <Zap className="w-5 h-5 text-neonGreen mb-2" />
                        <p className="text-xs font-bold text-white">Token Efficiency</p>
                        <p className="text-[10px] text-zinc-500 mt-1">Tracks burn rate, cache hits, and wasted turns. Shows how to do more within your usage caps.</p>
                    </div>
                    <div className="p-4 bg-[#050505] rounded-xl border border-[#222]">
                        <ArrowRight className="w-5 h-5 text-neonBlue mb-2" />
                        <p className="text-xs font-bold text-white">Smart Routing</p>
                        <p className="text-[10px] text-zinc-500 mt-1">Tells you which tool + model combo wins for each task type, based on your actual history.</p>
                    </div>
                    <div className="p-4 bg-[#050505] rounded-xl border border-[#222]">
                        <Terminal className="w-5 h-5 text-yellow-400 mb-2" />
                        <p className="text-xs font-bold text-white">IDE Interception</p>
                        <p className="text-[10px] text-zinc-500 mt-1">Detects stack traces in your terminal and pushes matched solutions before you even open a prompt.</p>
                    </div>
                    <div className="p-4 bg-[#050505] rounded-xl border border-[#222]">
                        <BarChart2 className="w-5 h-5 text-brand mb-2" />
                        <p className="text-xs font-bold text-white">Prompt Science</p>
                        <p className="text-[10px] text-zinc-500 mt-1">Mines your best sessions to find patterns. Effect sizes tell you exactly what improves quality.</p>
                    </div>
                    <div className="p-4 bg-[#050505] rounded-xl border border-[#222]">
                        <Shield className="w-5 h-5 text-red-400 mb-2" />
                        <p className="text-xs font-bold text-white">Anti-Hallucination</p>
                        <p className="text-[10px] text-zinc-500 mt-1">Mines failures to build an anti-pattern graph. Injects "DO NOT" clauses to block known bad patterns.</p>
                    </div>
                </div>
            </div>

            {/* CTA */}
            <div className="text-center">
                <button onClick={onDismiss}
                    className="px-8 py-3 rounded-xl text-sm font-black uppercase tracking-wider bg-brand/20 text-brand border border-brand/50 hover:bg-brand/30 hover:shadow-neon-brand transition-all">
                    {totalSessions > 0 ? 'Go to Dashboard' : 'Start — Data Collects Automatically'}
                </button>
                <p className="text-[9px] text-zinc-600 mt-3">100% local. Real semantic embeddings. Read-only. Zero telemetry.</p>
            </div>
        </div>
    );
}
