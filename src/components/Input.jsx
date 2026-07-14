export default function Input({
  label,
  icon: Icon,
  error,
  className = '',
  ...props
}) {
  return (
    <div className="w-full flex flex-col gap-1.5 text-left">
      {label && (
        <label className="text-xs font-semibold text-gray-300 pl-0.5">
          {label}
        </label>
      )}
      <div className="relative flex items-center">
        {Icon && (
          <div className="absolute left-3.5 text-gray-500 pointer-events-none flex items-center justify-center">
            <Icon size={16} className="opacity-80" />
          </div>
        )}
        <input
          className={`w-full bg-[#0a0b12]/50 border border-white/5 rounded-xl px-4 py-3 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-[#7c3aed] focus:ring-1 focus:ring-[#7c3aed] transition-all duration-200 ${Icon ? 'pl-11' : ''} ${error ? 'border-red-500 focus:border-red-500 focus:ring-red-500' : ''} ${className}`}
          {...props}
        />
      </div>
      {error && <span className="text-[10px] text-red-500 pl-1 mt-0.5">{error}</span>}
    </div>
  )
}
