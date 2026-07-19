import { OTPInput, OTPInputContext } from "input-otp";
import * as React from "react";

export function InputOtp(props: React.ComponentProps<typeof OTPInput>) {
  return <OTPInput {...props} containerClassName="gw-auth__otp" spellCheck={false} />;
}

export function InputOtpSlots() {
  return (
    <div className="gw-auth__otp-group">
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <InputOtpSlot key={index} index={index} />
      ))}
    </div>
  );
}

function InputOtpSlot({ index }: { readonly index: number }) {
  const context = React.useContext(OTPInputContext);
  const { char, hasFakeCaret, isActive } = context?.slots[index] ?? {};
  return (
    <div className="gw-auth__otp-slot" data-active={isActive || undefined}>
      {char}
      {hasFakeCaret ? <span className="gw-auth__otp-caret" /> : null}
    </div>
  );
}
