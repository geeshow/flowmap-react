import axios from 'axios';

// Third-party absolute URL → EXTERNAL node, unmatched in the join.
export async function geocode(address: string) {
  const res = await axios.get(`https://maps.googleapis.com/maps/api/geocode/json?address=${address}`);
  return res.data;
}
