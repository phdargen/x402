export default function ProtectedUnicodePage() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="max-w-2xl mx-auto p-8">
        <h1 className="text-4xl font-bold mb-4">Unicode Test — Success</h1>
        <p className="text-lg">
          Payment with Unicode in the description (café, naïve, 日本語, 🎵) succeeded.
          The PAYMENT-SIGNATURE encoding fix is working.
        </p>
      </div>
    </div>
  );
}
