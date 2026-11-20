import { Redirect } from 'expo-router';
import { EngineBench } from '../../src/dev/EngineBench';

export default function EngineBenchRoute() {
  return __DEV__ ? <EngineBench /> : <Redirect href="/" />;
}
