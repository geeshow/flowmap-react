import React, { useEffect } from 'react';
import { fetchAccountOpenable, fetchServiceTerms } from '../api/account';

// Component → fetchAccountOpenable → fetchData → http.get (2-level custom wrapper chain).
export default function AccountPage() {
  useEffect(() => {
    fetchAccountOpenable({ guideCode: 'g1' }).then((r) => console.log(r.partnerId));
    fetchServiceTerms(); // local `const { url } = config` destructure
  }, []);

  return <div className="account-page">account</div>;
}
