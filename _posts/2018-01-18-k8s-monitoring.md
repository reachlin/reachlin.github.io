---
title: kubernetes monitoring
---

This is a write-up for steps to create a monitoring system on [IBM kubernetes](https://www.ibm.com/cloud/container-service). This monitoring system is composed of prometheus and its blackbox exporter. It can monitor any web service and send alerts to PageDuty or your slack channel.

The reader should have basic knowledges on kubernetes, prometheus, alert manager, and blackbox exporter. This article is merely focus on steps to set up and configure them.

## Create your own kubernetes cluster on IBM Cloud

Although you can try kubernetes on IBM Cloud(aka bluemix) for free, I strongly recommend you to get paid account. You will need one from IBM Cloud and one from IBM Softlayer. Your k8s master node will be managed by IBM in IBM Cloud account and your k8s work nodes and networks will be in your Softlayer account.

1. Go to [IBM Cloud](https://console.bluemix.net/) and sign up.

2. Go to [IBM Softlayer](http://www.softlayer.com/) and sign up.

3. Gather necessary information for your account including API key, orgnization, and space name, etc.
```
export BX_API=https://api.ng.bluemix.net
export BX_KEY=<your bluemix key>
export BX_ACCOUNT=<your bluemix account id>
export BX_ORG=<orgnization>
export BX_SPACE=<space>
export BX_REGION=<region>
export BX_LOCATION=<location>
export SL_USER=<softlayer user>
export SL_KEY=<softlayer key>
export BX_MACHINE_TYPE=<TBD>
export BX_PUBLIC_VLAN=<TBD>
export BX_PRIVATE_VLAN=<TBD>
export BX_WORKERS=2
export BX_CLUSTER=test
```

4. Download and install bx client, or you can just run my container with bx installed from [here](https://hub.docker.com/r/reachlin/bluemix/)
```
docker run --name bluemix -d --privileged reachlin/bluemix
```

5. Login the bluemix container.
```
docker exec -it bluemix bash
```

6. Login your IBM cloud account.
```
export BX_API=https://api.ng.bluemix.net
export BX_KEY=<your bluemix key>
export BX_ACCOUNT=<your bluemix account id>
export BX_ORG=<orgnization>
export BX_SPACE=<space>
bx login -a $BX_API --apikey $BX_KEY -c $BX_ACCOUNT -o $BX_ORG -s $BX_SPACE
```

7. Find available machine types in your location.
```
bx cs regions
export BX_REGION=us-south
bx cs region-set $BX_REGION
bx cs locations
export BX_LOCATION=dal10
bx cs machine-types $BX_LOCATION
export BX_MACHINE_TYPE=u2c.2x4
```

8. Set your softlayer user and api key
```
export SL_USER=<softlayer user>
export SL_KEY=<softlayer key>
bx cs credentials-set --infrastructure-username $SL_USER --infrastructure-api-key $SL_KEY
```

9. Get your public and private vlan
```
bx sl vlan list
export BX_PUBLIC_VLAN=xxx
export BX_PRIVATE_VLAN=xxx
```

10. Check all your env variables and create your k8s cluster. We will deploy a prometheus into this cluster.
```
env|grep BX_
bx cs cluster-create --location $BX_LOCATION --public-vlan $BX_PUBLIC_VLAN --private-vlan $BX_PRIVATE_VLAN --machine-type $BX_MACHINE_TYPE --workers $BX_WORKERS --name $BX_CLUSTER
```

## Deploy prometheus

We will use prometheus plus blackbox to monitor any web service. The blackbox will check if configured URLs return 200. If not, it will report as metrics to prometheus. prometheus will ask alertmanager to send out alerts to pagerduty, slack, or any other output methods configured.

Check your cluster status `bx cs clusters|grep normal` and make sure it is ready before proceeding. Normally this will take less than an hour.

1. Get your cluster config.
```
bx cs cluster-config lincai0118
```

2. Install `kubectl`. If you use my container, it's already installed :) Please also make sure all worker nodes are in good shape.
```
export KUBECONFIG=...lincai0118.yml
kubectl get nodes
```

3. Install prometheus. prometheus needs a config file [/etc/prometheus/prometheus.yml](https://github.com/reachlin/docker/blob/master/prometheus/k8smonitoring.yml#L14) to start up.

4. Then we will import all configure files as a configmap of k8s, so we can mount it to prometheus, blackbox, or alertmanager containers as a file. You can tweak these configures in the yml to bettter serve your specific purpose.

5. We also need an alertmanger to send alerts to pagerduty, and a blackbox exporter to monitor the target web services. All configurations are in [the yml file](https://github.com/reachlin/docker/blob/master/prometheus/k8smonitoring.yml). Please replace `$PD_KEY` with your own key, and add your web service URLs to be monitored in [here](https://github.com/reachlin/docker/blob/master/prometheus/k8smonitoring.yml#L34), then apply the yml.
```
kubectl apply -f k8smonitoring.yml
```

6. For simplicity reasons, I only use node port to expose our service. So your can open any worker public IP with port 30090 to view the promethus console.
```
bx cs workers
```

If you change any configure in the yml after you apply this yml, you can just apply it again. But remember to delete the pod, so the changes can be picked up by containers.

## Advanced k8s monitoring

If you want to get more k8s metrics from prometheus, you have to configure `<kubernetes_sd_config>` in prometheus yml. This [kube-prometheus](https://github.com/coreos/prometheus-operator/tree/master/contrib/kube-prometheus) combines everything and provides an easy to install script. Please check it out.

```
apt-get update
apt-get install git
git clone https://github.com/coreos/prometheus-operator.git
cd prometheus-operator/contrib/kube-prometheus/
hack/cluster-monitoring/deploy 
kubectl get ns
kubectl get pods -o wide -n monitoring
```

By default, the promethues will listen on 30900, grafana on 30902, and alermanager on 30903 of any worker node.
