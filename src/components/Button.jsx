import { motion } from 'framer-motion'

export default function Button({
  children,
  onClick,
  type = 'button',
  variant = 'primary',
  className = '',
  disabled = false,
  ...props
}) {
  const baseStyle = "px-4 py-2.5 rounded-xl font-medium transition-all duration-200 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed text-sm"
  
  const variants = {
    primary: "bg-brand-purple hover:bg-brand-purple-hover text-white shadow-lg shadow-brand-purple/20",
    secondary: "bg-brand-blue hover:bg-brand-blue-hover text-white shadow-lg shadow-brand-blue/20",
    success: "bg-brand-green hover:bg-brand-green-hover text-white shadow-lg shadow-brand-green/20",
    danger: "bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-600/20",
    glass: "glassmorphism hover:bg-white/10 text-gray-200 border-white/10",
    ghost: "text-gray-400 hover:text-white hover:bg-white/5 border border-transparent",
  }

  return (
    <motion.button
      whileHover={{ scale: disabled ? 1 : 1.02 }}
      whileTap={{ scale: disabled ? 1 : 0.98 }}
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${baseStyle} ${variants[variant]} ${className}`}
      {...props}
    >
      {children}
    </motion.button>
  )
}
